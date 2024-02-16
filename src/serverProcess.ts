import { TextWriter, Uint8ArrayReader, ZipReader } from "@zip.js/zip.js";
import { ServerProcessContext } from "./clangd-context";

console.log("Launched server process");

function patchWorker() {
    //
    // Using JS file from another origin produces cross-origin error.
    // Just wrapping worker entrypoint.
    //
    const originalWorker = Worker;

    self.Worker = class ProxyWorker extends originalWorker {
        constructor(url: string | URL, option: WorkerOptions | undefined) {
            const blob = new Blob([ `importScripts("${url}");` ], { type: "text/javascript" });            
            const blobURL = URL.createObjectURL(blob);
            if (!option) {
                option = { name: "clangd Worker" };
            }
            super(blobURL, option);
        }
    };
}

patchWorker();

function writeFile(path: string, content: string | Uint8Array ) {
    const components = path.split("/");
    let creatingPath = "/";

    for (let i = 1; i < components.length - 1; i++) {
        creatingPath += (components[i] + "/");
        try {
            FS.mkdir(creatingPath);
        } catch (e) {
            // ignore
        }
    }
    FS.writeFile(path, content);
}

async function fetchAndInstallHeaders(url: string, base: string) {
    const bootstrap = await fetch(url);
    const bootstrapBuffer = await bootstrap.arrayBuffer();
    
    const fileReader = new Uint8ArrayReader(new Uint8Array(bootstrapBuffer));
    const zipReader = new ZipReader(fileReader);
    const files = await zipReader.getEntries(); 

    const promises = files.map(async file => {
        if (!file.getData) return;
        const textWriter = new TextWriter("utf8");
        const content = await file.getData<string>(textWriter);
        writeFile(base + file.filename, content);
    });
    
    await Promise.all(promises); 
}

async function loadInitialFiles(extensionUri: string, includes: string[]) {

    writeFile("/home/web_user/.config/clangd/config.yaml",
    `
CompileFlags:
    Add: [--target=wasm32-unknown, -I/usr/include]     
    `
    );

    const promises = includes
        .map(url => url.replace("${extensionUri}", extensionUri))
        .map(url => fetchAndInstallHeaders(url, "/usr/include/"));

    await Promise.all([
        fetchAndInstallHeaders(extensionUri + "/clangd/clang_includes.zip", "/usr/include/clang/"),
        ...promises
    ]);
}

declare global {
    var Module: any;
}

async function initialize(data: ServerProcessContext) {
  
    const commandPort = data.commandPort;
    const stdinPort = data.stdinPort;
    const stdoutPort = data.stdoutPort;
    const stderrPort = data.stderrPort;
    const extensionUri = data.extensionUri;
    const processArguments = data.arguments || [];
    const additionalPackage = data.additionalPackage;
    
    const stdinQueue: Uint8Array[] = [];
    const stdinData: (number | null)[] = [];
    let stdoutData: number[] = [];

    let carretCount = 0;
    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder();

    self.Module = {
        arguments: processArguments,
        thisProgram: "/usr/bin/clangd.wasm",
        waitForStdin() {
            if (stdinQueue.length === 0) {
                // Need to wait
                return new Promise(resolve => {
                    Module["waitForStdinPromise"] = resolve;
                });
            } else {
                return Promise.resolve();
            }
        },
        waitForStdinPromise: null,
        stdin() {
            while (stdinData.length === 0) {
                if (stdinQueue.length == 0) {
                    stdinData.push(...textEncoder.encode("Content-Length: 0\r\n\r\n"), null);
                    break;
                }
            
                const stdinBuffer = stdinQueue.shift() || [];
                stdinData.push(...stdinBuffer, null);
            }
            return stdinData.shift();
        },
        stdout(char: number) {
            stdoutData.push(char);

            const prevCarretCount = carretCount;

            if (char === 123) {
                carretCount++;
            } else if (char === 125) {
                carretCount--;
            }

            // The last of LSP message does not have '/n'.
            // Detect when parens are closed.
            if (prevCarretCount == 1 && carretCount == 0) {
                const buffer = new Uint8Array(stdoutData);
                const text = textDecoder.decode(buffer);

                stdoutPort.postMessage({
                    type: "stdout",
                    data: text
                });

                stdoutData = [];
            }
        },
        printErr(text: string) {
            stderrPort.postMessage(text);
        },
        locateFile(url: string) {
            return extensionUri + "/clangd/" + url;
        },
        mainScriptUrlOrBlob: extensionUri + "/clangd/clangd.js",
        onExit(code: number) {
            stdoutPort.postMessage({ 
                type: "exit",
                code
            })
        }
    };

    importScripts(extensionUri + "/clangd/clangd.js");

    stdinPort.onmessage = function(e) {
        const data = e.data;

        if (data && data.type === "stdin") {
            stdinQueue.push(new Uint8Array(data.buffer));

            if (!!Module["waitForStdinPromise"]) {
                const resume = Module["waitForStdinPromise"];
                Module["waitForStdinPromise"] = null;
                resume();
            }
        } 
    };

    commandPort.onmessage = function (e) {
        const data = e.data;

        if (!data) {
            return;
        }

        if (data.type === "create" || data.type === "change") {
            /** @type { string } */
            const fsPath = data.data.path;
            /** @type { string | ArrayBuffer } */
            const buffer = data.data.buffer;

            if (typeof buffer === "string") {
                writeFile(fsPath, buffer);
            } else {
                const offset = data.data.offset;
                const length = data.data.length;

                writeFile(fsPath, new Uint8Array(buffer, offset, length));
            }
        }
    };

    await loadInitialFiles(extensionUri, additionalPackage);
}

self.onmessage = function(e) {
    initialize(e.data);
}
