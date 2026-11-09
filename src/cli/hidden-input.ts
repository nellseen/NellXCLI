import type { ReadStream, WriteStream } from "node:tty";

export async function readHiddenInput(
  prompt: string,
  input: ReadStream = process.stdin,
  output: WriteStream = process.stderr,
): Promise<string> {
  output.write(prompt);
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    output.write("(read from stdin) ");
    let value = "";
    for await (const chunk of input) value += String(chunk);
    return value.trim();
  }

  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  let value = "";

  try {
    return await new Promise<string>((resolve, reject) => {
      const finish = (error?: Error) => {
        input.off("data", onData);
        input.setRawMode(wasRaw ?? false);
        output.write("\n");
        if (error) reject(error);
        else resolve(value);
      };
      const onData = (chunk: string | Buffer) => {
        for (const character of String(chunk)) {
          if (character === "\u0003") {
            finish(new Error("Secret input cancelled."));
            return;
          }
          if (character === "\r" || character === "\n") {
            finish();
            return;
          }
          if (character === "\u007f" || character === "\b") {
            value = value.slice(0, -1);
            continue;
          }
          if (character >= " ") value += character;
        }
      };
      input.on("data", onData);
    });
  } finally {
    input.pause();
  }
}
