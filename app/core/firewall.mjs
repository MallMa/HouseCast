import { spawn } from "node:child_process";
import net from "node:net";

const literal = (value) => `'${value.replaceAll("'", "''")}'`;
export async function allowHomeNetwork({ script, executable, network }) {
  if (!network || !net.isIPv4(network.address) || !net.isIPv4(network.netmask))
    throw new Error("Choose a home network first.");
  if ([script, executable].some((s) => /["\r\n]/.test(s)))
    throw new Error("The application path cannot contain quotes or newlines.");
  const argumentsText = `-NoProfile -ExecutionPolicy Bypass -File "${script}" -ExecutablePath "${executable}" -Address ${network.address} -Netmask ${network.netmask}`;
  const command = `$ErrorActionPreference='Stop';try{$p=Start-Process -FilePath powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList ${literal(argumentsText)} -PassThru -Wait;exit $p.ExitCode}catch{exit 1223}`;
  await new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(command, "utf16le").toString("base64"),
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              code === 1223
                ? "Windows approval was cancelled. Speaker connections are still blocked."
                : "Windows could not add the home-network rule. Check administrator access.",
            ),
          ),
    );
  });
}
