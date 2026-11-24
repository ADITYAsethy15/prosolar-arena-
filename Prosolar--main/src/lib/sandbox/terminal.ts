// ============================================================================
// Interactive shell for the sandbox panel: one persistent /bin/jsh process.
//
// This is the *user's* terminal (the panel's Terminal tab), not the agent's command
// path. The agent spawns a fresh process per command in runner.ts — bolt.diy does
// the same, and it matters: a dev server in a shared shell would hold the shell's
// stdin forever, so the next tool call would queue behind a process that never
// exits. Two separate mechanisms, one visible terminal.
//
// jsh (`/bin/jsh --osc`) reports readiness with OSC markers:
//   ESC ] 654 ; interactive BEL   -> line editor is up, keystrokes will be accepted
// Forwarding keystrokes before that marker drops them silently, which is what makes
// a freshly opened terminal look dead.
// ============================================================================
import type { WebContainerProcess } from '@webcontainer/api';
import { getContainer } from './container';
import { toContainerPath, WORKSPACE_ROOT } from './path';

export type TerminalSink = {
  write: (chunk: string) => void;
  cols?: number;
  rows?: number;
};

const OSC_MARKER = /\x1b\]654;([^\x07]*)\x07/;

class InteractiveShell {
  #process: WebContainerProcess | null = null;
  #input: WritableStreamDefaultWriter<string> | null = null;
  #ready: Promise<void> | null = null;
  #terminal: TerminalSink | null = null;
  #interactive = false;

  /** The panel's xterm. Everything the user types and every agent command is mirrored here. */
  attachTerminal(terminal: TerminalSink | null): void {
    this.#terminal = terminal;
  }

  get attached(): boolean {
    return Boolean(this.#terminal);
  }

  async init(): Promise<void> {
    if (this.#ready) {
      return this.#ready;
    }
    this.#ready = (async () => {
      const container = await getContainer();
      let process: WebContainerProcess;
      try {
        process = await container.spawn('/bin/jsh', ['--osc'], {
          cwd: toContainerPath(WORKSPACE_ROOT),
          terminal: { cols: this.#terminal?.cols ?? 80, rows: this.#terminal?.rows ?? 18 },
          env: { FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'xterm-256color', npm_config_yes: 'true' },
        });
      } catch (err) {
        // Do not cache a failed boot: a later attempt (after a container reboot) may work.
        this.#ready = null;
        throw new Error(`could not start /bin/jsh: ${String((err as Error)?.message ?? err)}`);
      }
      this.#process = process;
      this.#input = process.input.getWriter();

      let sawInteractive = false;
      const ready = new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 12_000);
        void process.output
          .pipeTo(
            new WritableStream<string>({
              write: (chunk) => {
                this.#terminal?.write(chunk);
                if (!sawInteractive && OSC_MARKER.exec(chunk)?.[1] === 'interactive') {
                  sawInteractive = true;
                  this.#interactive = true;
                  clearTimeout(timer);
                  resolve();
                }
              },
            }),
          )
          .catch(() => {
            this.#terminal?.write('\r\n[shell output stream closed]\r\n');
            clearTimeout(timer);
            resolve();
          });
      });
      await ready;
      // Even if the marker never arrived, jsh is usually usable; a false "interactive"
      // only costs a dropped keystroke, while refusing input makes the tab useless.
      this.#interactive = true;
    })();
    return this.#ready;
  }

  /** Called by the panel on every keystroke. */
  sendInput(data: string): void {
    if (this.#input) {
      void this.#input.write(data).catch(() => undefined);
    }
  }

  /** Print a line in the terminal from outside (agent commands, notices). */
  write(chunk: string): void {
    this.#terminal?.write(chunk);
  }

  dispose(): void {
    try {
      this.#process?.kill();
    } catch {
      // already gone
    }
    this.#process = null;
    this.#input = null;
    this.#interactive = false;
    this.#ready = null;
  }
}

export const interactiveShell = new InteractiveShell();

/** True once jsh has been seen and input is being forwarded. */
export function shellIsLive(): boolean {
  return interactiveShell.attached;
}
