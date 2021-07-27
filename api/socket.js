import { readFileSync } from "fs";

import * as pty from "node-pty";

import {
  Kernel,
  WrappedKernel,
  constructMessage,
  constructExecuteRequest,
} from "./kernel.js";

export const listenOnRepl = (() => {
  let procs = {};
  return (socket) => {
    // FIXME kill previous julia process?
    let proc;
    socket.on("spawn", (sessionId, lang) => {
      if (sessionId in procs && lang in procs[sessionId]) {
        // already exist
        proc = procs[sessionId][lang];
      } else {
        switch (lang) {
          case "julia":
            proc = pty.spawn("julia");
            break;
          case "python":
            proc = pty.spawn("python3");
            break;
          default:
            console.log(`Invalid language: ${lang}`);
            return;
        }
        if (!(sessionId in procs)) {
          procs[sessionId] = {};
        }
        procs[sessionId][lang] = proc;
      }
      // This will broadcast output to all REPL pods
      //
      // How did Jupyter handle this? Each cell send code to the server. The
      // server evaluate it and send back. The front-end then know which cell
      // sends the code? Or the cell send the result together with the cell ID?
      //
      // Actually the terminal monitor each stroke, so probably I cannot do it
      // better. I would skip terminal for now, as it is not too critical.
      proc.onData((data) => {
        socket.emit("terminalOutput", data);
      });
      proc.onExit(({ exitCode, signal }) => {});
    });

    socket.on("terminalInput", (data) => {
      if (proc) {
        proc.write(data);
      } else {
        console.log("warning: received input, but proc not connected");
      }
    });
  };
})();

export const listenOnKernelManagement = (() => {
  let kernelTerminals = {
    julia: null,
    racket: null,
  };

  return (socket) => {
    socket.on("kernelTerminalSpawn", (lang) => {
      // if (!kernelTerminals[lang]) {
      // kernelTerminals[lang].kill();
      let container_name = `${lang}_kernel_1`;
      let cmd = `/usr/local/bin/docker exec -it ${container_name} bash -c '/start.sh'`;
      console.log("====== spawning ", cmd);
      // console.log(cmd.split(" ")[0]);
      // console.log(cmd.split(" ").splice(1));
      // let proc = pty.spawn(cmd.split()[0], cmd.split().splice(1));
      let proc = pty.spawn("docker", [
        "exec",
        "-it",
        `${lang}_kernel_1`,
        "bash",
        "-c",
        "'/start.sh'",
      ]);
      // let proc = pty.spawn("julia");
      kernelTerminals[lang] = proc;
      // }
      console.log("setting callback ..");
      kernelTerminals[lang].onData((data) => {
        // console.log("-----", data);
        socket.emit("kernelTerminalOutput", {
          lang,
          data,
        });
      });
    });

    socket.on("kernelTerminalInput", ({ lang, data }) => {
      // console.log("received input ..");
      if (kernelTerminals[lang]) {
        kernelTerminals[lang].write(data);
      }
    });
  };
})();

export const listenOnRunCode = (() => {
  console.log("connnecting to kernel ..");
  let kernels = {
    julia: new WrappedKernel(
      "./kernels/julia/conn.json",
      readFileSync("./kernels/julia/codepod.jl", "utf8")
    ),
    racket: new WrappedKernel(
      "./kernels/racket/conn.json",
      readFileSync("./kernels/racket/codepod.rkt", "utf8")
    ),
    python: new WrappedKernel(
      "./kernels/python/conn.json",
      readFileSync("./kernels/python/codepod.py", "utf8")
    ),
    js: new WrappedKernel(
      "./kernels/javascript/conn.json",
      readFileSync("./kernels/javascript/codepod.js", "utf8")
    ),
    ts: new Kernel("./kernels/javascript/ts.conn.json"),
  };
  console.log("kernel connected");

  return (socket) => {
    // listen IOPub
    for (const [lang, kernel] of Object.entries(kernels)) {
      kernel.listenIOPub((topic, msgs) => {
        // console.log("-----", topic, msgs);
        // iracket's topic seems to be an ID. I should use msg type instead
        switch (msgs.header.msg_type) {
          case "status": {
            console.log("emiting status ..");
            socket.emit("status", lang, msgs.content.execution_state);
            break;
          }
          case "execute_result": {
            console.log("emitting execute_result ..");
            let [podId, name] = msgs.parent_header.msg_id.split("#");
            let payload = {
              podId,
              name,
              result: msgs.content.data["text/plain"],
              count: msgs.content.execution_count,
            };
            if (name) {
              console.log("emitting IO result");
              socket.emit("IO:execute_result", payload);
            } else {
              socket.emit("execute_result", payload);
            }
            break;
          }
          case "stdout": {
            console.log("emitting stdout ..");
            if (msgs.content.text.startsWith("base64 binary data")) {
              console.log("warning: base64 encoded stdout");
            } else {
              let [podId, name] = msgs.parent_header.msg_id.split("#");
              let payload = {
                podId,
                name,
                stdout: msgs.content.text,
              };
              if (name) {
                // this is Import/Export cmd
                socket.emit("IO:stdout", payload);
              } else {
                socket.emit("stdout", payload);
              }
            }
            break;
          }
          case "error": {
            console.log("emitting error ..");
            let [podId, name] = msgs.parent_header.msg_id.split("#");
            let payload = {
              podId,
              name,
              stacktrace: msgs.content.traceback,
              ename: msgs.content.ename,
              evalue: msgs.content.evalue,
            };
            if (name) {
              socket.emit("IO:error", payload);
            } else {
              socket.emit("error", payload);
            }
            break;
          }
          case "stream": {
            if (!msgs.parent_header.msg_id) {
              console.log("No msg_id, skipped");
              console.log(msgs.parent_header);
              break;
            }
            let [podId, name] = msgs.parent_header.msg_id.split("#");
            // iracket use this to send stderr
            // FIXME there are many frames
            if (msgs.content.name === "stdout") {
              // console.log("ignore stdout stream");
              console.log("emitting stdout stream ..");
              socket.emit("stream", {
                podId,
                text: msgs.content.text,
              });
            } else if (msgs.content.name === "stderr") {
              console.log("emitting error stream ..");
              if (!name) {
                socket.emit("stream", {
                  podId,
                  text: msgs.content.text,
                });
              } else {
                // FIXME this is stream for import/export. I should move it somewhere
                socket.emit("stream", {
                  podId,
                  text: msgs.content.text,
                });
              }
            } else {
              console.log(msgs);
              throw new Error(`Invalid stream type: ${msgs.content.name}`);
            }
            break;
          }
          default:
            console.log(
              "Message Not handled",
              msgs.header.msg_type,
              "topic:",
              topic
            );
            // console.log("Message body:", msgs);
            break;
        }
      });
    }

    socket.on("runCode", ({ lang, raw, code, podId, namespace, midports }) => {
      if (!(lang in kernels)) {
        console.log("Invalid language", lang);
        socket.emit("stdout", {
          podId: podId,
          stdout: `Error: Invalid Language ${lang}`,
        });
        return;
      }
      if (!code) {
        console.log("Code is empty");
        return;
      }
      if (raw) {
        kernels[lang].sendShellMessage(
          constructExecuteRequest({
            code,
            msg_id: podId,
          })
        );
        return;
      }
      switch (lang) {
        case "python":
          {
            code = `CODEPOD_EVAL("""${code.replaceAll(
              '"',
              '\\"'
            )}""", "${namespace}")`;
            console.log("---- the code", code);
            kernels[lang].sendShellMessage(
              constructExecuteRequest({
                code,
                msg_id: podId,
              })
            );
          }
          break;
        case "js":
          {
            let names = [];
            if (midports) {
              names = midports.map((name) => `"${name}"`);
            }
            let code1 = `CODEPOD.eval(\`${code}\`, "${namespace}", [${names.join(
              ","
            )}])`;
            console.log("js wrapper code:", code1);
            kernels[lang].sendShellMessage(
              constructExecuteRequest({
                code: code1,
                msg_id: podId,
              })
            );
          }
          break;
        case "julia":
          {
            kernels[lang].sendShellMessage(
              constructExecuteRequest({
                code: `CODEPOD_EVAL("""${code}""", "${namespace}")`,
                msg_id: podId,
              })
            );
          }
          break;
        case "racket":
          {
            kernels[lang].sendShellMessage(
              constructExecuteRequest({
                code: `(enter! #f) (CODEPOD-EVAL "${code}" "${namespace}")`,
                msg_id: podId,
              })
            );
          }
          break;
        default: {
          kernels[lang].sendShellMessage(
            constructExecuteRequest({
              code,
              msg_id: podId,
            })
          );
        }
      }
    });

    socket.on("requestKernelStatus", (lang) => {
      if (lang in kernels) {
        kernels[lang].sendShellMessage(
          constructMessage({ msg_type: "kernel_info_request" })
        );
      } else {
        console.log("Invalid requestKernelStatus for lang", lang);
      }
    });

    socket.on("ensureImports", ({ lang, id, from, to, names }) => {
      if (lang === "python") {
        console.log("ensureImports for python");
        // only python needs to re-evaluate for imports
        for (let name of names) {
          let code = `CODEPOD_EVAL("""${name} = CODEPOD_GETMOD("${from}").__dict__["${name}"]\n0""", "${to}")`;
          console.log("---- the code:", code);
          kernels[lang].sendShellMessage(
            constructExecuteRequest({
              code,
              msg_id: id + "#" + name,
            })
          );
        }
      }
    });

    socket.on("addImport", ({ lang, id, from, to, name }) => {
      console.log("received addImport");
      switch (lang) {
        case "python":
          {
            // FIXME this should be re-evaluated everytime the function changes
            // I cannot use importlib because the module here lacks the finder, and
            // some other attribute functions
            let code = `CODEPOD_EVAL("""${name} = CODEPOD_GETMOD("${from}").__dict__["${name}"]\n0""", "${to}")`;
            console.log("---- the code", code);
            kernels[lang].sendShellMessage(
              constructExecuteRequest({
                code,
                msg_id: id + "#" + name,
              })
            );
          }
          break;
        case "js":
          {
            let code = `CODEPOD.addImport("${from}", "${to}", "${name}")`;
            console.log("---- the code", code);
            kernels[lang].sendShellMessage(
              constructExecuteRequest({
                code,
                msg_id: id + "#" + name,
              })
            );
          }
          break;
        case "julia":
          {
            kernels[lang].sendShellMessage(
              constructExecuteRequest({
                code: `CODEPOD_ADD_IMPORT("${from}", "${to}", "${name}")`,
                msg_id: id + "#" + name,
              })
            );
          }
          break;
        case "racket":
          {
            kernels[lang].sendShellMessage(
              constructExecuteRequest({
                code: `(enter! #f) (CODEPOD-ADD-IMPORT "${from}" "${to}" "${name}")`,
                msg_id: id + "#" + name,
              })
            );
          }
          break;
        default: {
          console.log("WARNING: unsupported language:", lang);
        }
      }
    });
    socket.on("deleteImport", ({ lang, id, name, ns }) => {
      console.log("received addImport");
      switch (lang) {
        case "python":
          {
            // FIXME this should be re-evaluated everytime the function changes
            // I cannot use importlib because the module here lacks the finder, and
            // some other attribute functions
            let code = `CODEPOD_EVAL("del ${name}", "${ns}")`;
            console.log("---- the code", code);
            kernels[lang].sendShellMessage(
              constructExecuteRequest({
                code,
                msg_id: id + "#" + name,
              })
            );
          }
          break;
        case "js":
          {
            let code = `CODEPOD.deleteImport("${ns}", "${name}")`;
            console.log("---- the code", code);
            kernels[lang].sendShellMessage(
              constructExecuteRequest({
                code,
                msg_id: id + "#" + name,
              })
            );
          }
          break;
        case "julia":
          {
            kernels[lang].sendShellMessage(
              constructExecuteRequest({
                code: `CODEPOD_DELETE_IMPORT("${ns}", "${name}")`,
                msg_id: id + "#" + name,
              })
            );
          }
          break;
        case "racket":
          {
            kernels[lang].sendShellMessage(
              constructExecuteRequest({
                code: `(enter! #f) (CODEPOD-DELETE-IMPORT "${ns}" "${name}")`,
                msg_id: id + "#" + name,
              })
            );
          }
          break;
        default: {
          console.log("WARNING: invalid lang:", lang);
        }
      }
    });
    socket.on("deleteMidport", ({ lang, id, ns, name }) => {
      if (lang !== "js") {
        throw new Error("Only js supprot deleteMidport.");
      }
      let code1 = `CODEPOD.deleteNames("${ns}", ["${name}"])`;
      console.log("js wrapper code:", code1);
      kernels[lang].sendShellMessage(
        constructExecuteRequest({
          code: code1,
          msg_id: id,
        })
      );
    });
  };
})();