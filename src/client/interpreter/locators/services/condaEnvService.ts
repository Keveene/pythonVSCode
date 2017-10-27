'use strict';
import * as child_process from 'child_process';
import * as fs from 'fs-extra';
import * as path from 'path';
import { Uri } from 'vscode';
import { VersionUtils } from '../../../common/versionUtils';
import { IInterpreterLocatorService, PythonInterpreter } from '../../contracts';
import { AnacondaCompanyName, AnacondaDisplayName, CONDA_RELATIVE_PY_PATH } from './conda';

type CondaInfo = {
    envs?: string[];
    'sys.version'?: string;
    default_prefix?: string;
    conda_version?: string;
    python_version?: string;
    platform?: string;
};
export class CondaEnvService implements IInterpreterLocatorService {
    constructor(private registryLookupForConda?: IInterpreterLocatorService) {
    }
    public getInterpreters(resource?: Uri) {
        return this.getSuggestionsFromConda();
    }
    // tslint:disable-next-line:no-empty
    public dispose() { }
    public getCondaFile() {
        if (this.registryLookupForConda) {
            return this.registryLookupForConda.getInterpreters()
                .then(interpreters => interpreters.filter(this.isCondaEnvironment))
                .then(condaInterpreters => this.getLatestVersion(condaInterpreters))
                .then(condaInterpreter => {
                    return condaInterpreter ? path.join(path.dirname(condaInterpreter.path), 'conda.exe') : 'conda';
                })
                .then(condaPath => {
                    return fs.pathExists(condaPath).then(exists => exists ? condaPath : 'conda');
                });
        }
        return Promise.resolve('conda');
    }
    public isCondaEnvironment(interpreter: PythonInterpreter) {
        return (interpreter.displayName || '').toUpperCase().indexOf('ANACONDA') >= 0 ||
            (interpreter.companyDisplayName || '').toUpperCase().indexOf('CONTINUUM') >= 0;
    }
    public getLatestVersion(interpreters: PythonInterpreter[]) {
        const sortedInterpreters = interpreters.filter(interpreter => interpreter.version && interpreter.version.length > 0);
        // tslint:disable-next-line:no-non-null-assertion
        sortedInterpreters.sort((a, b) => VersionUtils.compareVersion(a.version!, b.version!));
        if (sortedInterpreters.length > 0) {
            return sortedInterpreters[sortedInterpreters.length - 1];
        }
    }
    public async parseCondaInfo(info: CondaInfo) {
        const displayName = this.getDisplayName(info);

        // The root of the conda environment is itself a Python interpreter
        // envs reported as e.g.: /Users/bob/miniconda3/envs/someEnv.
        const envs = Array.isArray(info.envs) ? info.envs : [];
        if (info.default_prefix && info.default_prefix.length > 0) {
            envs.push(info.default_prefix);
        }

        const promises = envs
            .map(env => {
                // If it is an environment, hence suffix with env name.
                const interpreterDisplayName = env === info.default_prefix ? displayName : `${displayName} (${path.basename(env)})`;
                // tslint:disable-next-line:no-unnecessary-local-variable
                const interpreter: PythonInterpreter = {
                    path: path.join(env, ...CONDA_RELATIVE_PY_PATH),
                    displayName: interpreterDisplayName,
                    companyDisplayName: AnacondaCompanyName
                };
                return interpreter;
            })
            .map(env => fs.pathExists(env.path).then(exists => exists ? env : null));

        return Promise.all(promises)
            .then(interpreters => interpreters.filter(interpreter => interpreter !== null && interpreter !== undefined))
            // tslint:disable-next-line:no-non-null-assertion
            .then(interpreters => interpreters.map(interpreter => interpreter!));
    }
    public getDisplayName(info: CondaInfo) {
        const condaVersion = info.conda_version || '';
        const pythonVersion = this.getDisplayVersion(info.python_version);
        const bitness = this.getBitnessDisplayName(info.platform);
        const bitnesAndVersion = [bitness, pythonVersion].filter(item => item.length > 0).join(', ');

        if (condaVersion.length === 0 && pythonVersion.length === 0 && bitnesAndVersion.length === 0) {
            const sysVersion = info['sys.version'];
            if (typeof sysVersion === 'string') {
                return this.getDisplayNameFromSysVersion(sysVersion);
            }
        }

        return [AnacondaCompanyName, condaVersion, bitnesAndVersion.length > 0 ? `(${bitnesAndVersion})` : '']
            .filter(item => item.length > 0)
            .join(' ')
            .trim();
    }
    private getSuggestionsFromConda(): Promise<PythonInterpreter[]> {
        return this.getCondaFile()
            .then(condaFile => {
                return new Promise<PythonInterpreter[]>((resolve, reject) => {
                    // interrogate conda (if it's on the path) to find all environments.
                    child_process.execFile(condaFile, ['info', '--json'], (_, stdout) => {
                        if (stdout.length === 0) {
                            return resolve([]);
                        }

                        try {
                            const info = JSON.parse(stdout);
                            resolve(this.parseCondaInfo(info));
                        } catch (e) {
                            // Failed because either:
                            //   1. conda is not installed.
                            //   2. `conda info --json` has changed signature.
                            //   3. output of `conda info --json` has changed in structure.
                            // In all cases, we can't offer conda pythonPath suggestions.
                            return resolve([]);
                        }
                    });
                });
            });
    }
    private getDisplayNameFromSysVersion(versionInfo: string = '') {
        // "sys.version": "3.6.1 |Anaconda 4.4.0 (64-bit)| (default, May 11 2017, 13:25:24) [MSC v.1900 64 bit (AMD64)]".
        if (!versionInfo) {
            return AnacondaDisplayName;
        }

        const versionParts = versionInfo.split('|').map(item => item.trim());
        if (versionParts.length > 1 && versionParts[1].indexOf('conda') >= 0) {
            return versionParts[1];
        }
        return AnacondaDisplayName;
    }
    private getDisplayVersion(value: string = '') {
        return value.split('.')
            .filter((_, index) => index < 3)
            .join('.');
    }
    private getBitnessDisplayName(value: string = '') {
        const parsedValue = value.indexOf('-') > 0 ? value.split('-')[1] : value;
        const x64Values = ['64', 'x86', 'x86_64'];
        if (x64Values.some(item => value.indexOf(item) >= 0)) {
            return '64 bit';
        }
        const x86Values = ['32', 'i686', 'i386'];
        if (x86Values.some(item => value.indexOf(item) >= 0)) {
            return '32 bit';
        }
        return value;
    }
}
