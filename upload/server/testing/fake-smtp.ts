// A fake Google Workspace SMTP relay for the Reviewers' email (#61): a real
// SMTP server on an ephemeral port, offering STARTTLS with smtp-server's own
// test certificate and no authentication, as the relay is set up (ADR 0006).
// It keeps every message it accepts, parsed, with how it arrived, and can
// refuse on demand.
import type { AddressInfo } from "node:net";
import { simpleParser, type ParsedMail } from "mailparser";
import { SMTPServer } from "smtp-server";

export interface Received {
  from: string;
  to: string[];
  /** The name the client gave in EHLO. */
  ehlo: string;
  /** Whether STARTTLS was done before the message. */
  secure: boolean;
  /** The message exactly as sent. */
  raw: string;
  mail: ParsedMail;
}

export interface FakeSmtp {
  port: number;
  received: Received[];
  /** How many more messages to refuse (with a temporary failure) before accepting again. */
  refuseNext: number;
  /** Every try, accepted or not. */
  tries: number;
  close: () => Promise<void>;
}

export async function startFakeSmtp(): Promise<FakeSmtp> {
  const fake: FakeSmtp = { port: 0, received: [], refuseNext: 0, tries: 0, close: async () => {} };
  const server = new SMTPServer({
    // No AUTH offered: the relay trusts the server's IP.
    authOptional: true,
    disabledCommands: ["AUTH"],
    logger: false,
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        fake.tries++;
        if (fake.refuseNext > 0) {
          fake.refuseNext--;
          const err = Object.assign(new Error("try again later"), { responseCode: 451 });
          return callback(err);
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        simpleParser(raw).then(
          (mail) => {
            fake.received.push({
              from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
              to: session.envelope.rcptTo.map((r) => r.address),
              ehlo: session.hostNameAppearsAs,
              secure: session.secure,
              raw,
              mail,
            });
            callback();
          },
          (err: Error) => callback(err),
        );
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.port = (server.server.address() as AddressInfo).port;
  fake.close = () => new Promise((resolve) => server.close(() => resolve()));
  return fake;
}
