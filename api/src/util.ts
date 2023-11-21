import { spawnSync } from 'child_process';
import { readdirSync, readlinkSync, statSync } from 'fs';
import { join } from 'path';


function getStatSafe(path: string) {
    try {
        return statSync(path);
    } catch (_) {
        return false;
    }

}

function scanPythons(dir: string) {
    const pythons: string[] = [];

    const stat = getStatSafe(dir);

    if (!stat) {
        return pythons;
    }

    if (!stat.isDirectory()) {
        return pythons;
    }

    readdirSync(dir).forEach(file => {
        const fullPath = join(dir, file);
        const stat = getStatSafe(fullPath);

        if (!stat) {
            return;
        }

        if (/^python(\d?|3.\d+)$/g.test(file)) {
            if (stat.isFile()) {
                pythons.push(fullPath);
            }

            if (stat.isSymbolicLink()) {
                const orgPath = readlinkSync(fullPath);
                if (statSync(orgPath).isFile()) {
                    pythons.push(orgPath);
                }
            }
        }
    })

    return pythons;
}

function isWithKernel(python: string) {
    const proc = spawnSync(python, ['-m', 'ipykernel', '--version', '2']);

    const result = proc.stdout.toString().trim();

    if (/^(\d|\.)+$/g.test(result)) {
        return true;
    }

    return false;
}


export function scanPythonsWithKernel() {
    const pythonsPaths = new Set<string>();

    const path = process.env.PATH || "";

    const paths = path.split(":");

    paths.forEach(path => {
        scanPythons(path).forEach(python => {
            pythonsPaths.add(python);
        });
    });

    return Array.from(pythonsPaths).filter(python => isWithKernel(python));
}
