// The app reports which OS it runs on; wording follows it (the website build has no status -> neutral).
export const isWindows = (status) => status?.platform === "win32";
export const vaultName = (status) => (isWindows(status) ? "Windows Credential Manager" : "macOS Keychain");
export const deviceName = (status) => (isWindows(status) ? "PC" : status?.platform === "darwin" ? "Mac" : "computer");
