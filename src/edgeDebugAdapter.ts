/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ChromeDebugAdapter, IChromeDebugSessionOpts, ChromeDebugSession, utils, logger } from 'vscode-chrome-debug-core';
import { EdgeDebugSession } from './edgeDebugSession';
import { DebugProtocol } from 'vscode-debugprotocol';
import * as extensionUtils from './utilities';
import * as childProcess from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export class EdgeDebugAdapter extends ChromeDebugAdapter {
    private _adapterProc: childProcess.ChildProcess;
    private _adapterPort: number;

    private _launchAdapter(args?: any): Promise<any> {
        let adapterExePath = args.runtimeExecutable;
        if (!adapterExePath) {
            adapterExePath = extensionUtils.getAdapterPath();
        }

        logger.log(`Launching adapter at with arguments:', ${JSON.stringify(arguments)})`);

        // Check that debug adpater executable exists
        if (!fs.existsSync(adapterExePath)) {
            if (utils.getPlatform() == utils.Platform.Windows) {
                return utils.errP(`No Edge Diagnostics Adapter was found. Install the Edge Diagnostics Adapter (https://github.com/Microsoft/edge-diagnostics-adapter) and specify a valid 'adapterExecutable' path`);
            } else {
                return utils.errP(`Edge debugging is only supported on Windows 10.`);
            }
        }

        // Check that user is running a supported version of NodeJs (10 or higher)
        const nodeVersion = parseInt(process.version.slice(1));
        if (nodeVersion < 10) {
            return utils.errP(`Vscode-Debugger-For-Office-Addins require NodeJs 10 or higher.  Currently installed version is ${nodeVersion}`);
        }

        let adapterArgs: string[] = [];
        if (!args.port) {
            args.port = 9222;
        }
        // We always tell the adpater what port to listen on so there's no shared info between the adapter and the extension
        let portCmdArg = '--port=' + args.port;
        this._adapterPort = args.port;
        adapterArgs.push(portCmdArg);

        args.sourceMapPathOverrides = extensionUtils.getSourceMapPathOverrides(args.webRoot, args.sourceMapPathOverrides);

        if (args.url) {
            let launchUrlArg = '--launch=' + args.url;
            adapterArgs.push(launchUrlArg);
        }

        // The adapter might already be running if so don't spawn a new one
        return utils.getURL(`http://127.0.0.1:${args.port}/json/version`).then((jsonResponse: any) => {
            try {
                const responseArray = JSON.parse(jsonResponse);
                let targetBrowser: string = responseArray.Browser;
                targetBrowser = targetBrowser.toLocaleLowerCase();
                if (targetBrowser.indexOf('edge') > -1) {
                    return Promise.resolve(args);
                }

                return utils.errP(`Sever for ${targetBrowser} already listening on :9222`);
            } catch (ex) {
                return utils.errP(`Sever already listening on :9222 returned ${ex}`);
            }

        }, () => {
            const adapterPath = path.resolve(__dirname, '../../node_modules/debug-adapter-for-office-addins');
            const adpaterFile = path.join(adapterPath, "out/src/edgeAdapter.js");
            const adapterLaunch: string = `node ${adpaterFile}  --servetools --diagnostics`;
            logger.log(`spawn('${adapterLaunch}')`);
            this._adapterProc = childProcess.spawn(adapterLaunch, [], {
                detached: false,
                shell: true,
                stdio: "pipe",
                windowsHide: true
            });

            this._adapterProc.stderr.on("error", (err) => {
                logger.error(`Adapter error: ${err}`);
                this.terminateSession(`${err}`);
            });

            this._adapterProc.stdout.on("data", (data) => {
                logger.log(`Adapter output: ${data}`)
            });

            return Promise.resolve(args);
        });
    }

    public constructor(opts?: IChromeDebugSessionOpts, debugSession?: ChromeDebugSession) {
        if (debugSession == null) {
            debugSession = new EdgeDebugSession(false);
        }
        super(opts, debugSession);
    }

    public launch(args: any): Promise<void> {
        logger.log(`Launching Edge`);

        let launchUrl: string;
        if (args.file) {
            launchUrl = 'file:///' + path.resolve(args.cwd, args.file);
        } else if (args.url) {
            launchUrl = args.url;
        }

        return this._launchAdapter(args).then((attachArgs: any) => {
            return super.attach(attachArgs);
        });
    }

    public attach(args: any): Promise<void> {
        logger.log(`Attaching to Edge`);

        return this._launchAdapter(args).then((attachArgs: any) => {
            return super.attach(attachArgs);
        });
    }

    public disconnect(args: DebugProtocol.DisconnectArguments):Promise<void> {
        const closeDebuggerInstanceUrl: string = `http://127.0.0.1:${this._adapterPort}/json/close/${this._chromeConnection.attachedTarget.id}`;
        // Call adpater service to close debugger instance
        return utils.getURL(closeDebuggerInstanceUrl).then(() => {
            // Do additional clean-up
            this.clearEverything();
            super.disconnect(args);
        });
    }

    public clearEverything(): void {
        if (this._adapterProc) {
            this._adapterProc.kill('SIGINT');
            this._adapterProc = null;
        }
        super.clearTargetContext();
    }
}

