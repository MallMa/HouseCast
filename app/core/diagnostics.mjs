import fs from "node:fs/promises";
import path from "node:path";

// Bounded local diagnostics contain counters/state, never recorded audio.
export class Diagnostics {
  constructor(directory) {
    this.file = path.join(directory, "stream-diagnostics.jsonl");
    this.pending = Promise.resolve();
  }
  write(event, details = {}) {
    const entry = JSON.stringify({
      at: new Date().toISOString(),
      event,
      ...details,
    });
    this.pending = this.pending
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const size = await fs.stat(this.file).then(
          (s) => s.size,
          () => 0,
        );
        if (size > 2_000_000) {
          await fs.rm(this.file + ".previous", { force: true });
          await fs.rename(this.file, this.file + ".previous");
        }
        await fs.appendFile(this.file, entry + "\n");
      })
      .catch((error) => {
        this.error = error.message;
      });
  }
  async read() {
    await this.pending;
    return (await fs.readFile(this.file, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-1500)
      .map((line) => JSON.parse(line));
  }
}
