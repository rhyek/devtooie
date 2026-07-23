export function createPlainStatusReporter(): { update(msg: string): void; done(): void } {
  const isTty = Boolean(process.stdout.isTTY);
  let timer: NodeJS.Timeout | null = null;
  let dots = 0;
  let current = '';
  const render = () => {
    dots = (dots + 1) % 4;
    process.stdout.write(`\r${current}${'.'.repeat(dots)}${' '.repeat(3 - dots)}`);
  };
  return {
    update(msg: string) {
      current = msg;
      if (isTty) {
        if (!timer) {
          timer = setInterval(render, 300);
        }
      } else {
        process.stdout.write(`${msg}\n`);
      }
    },
    done() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (isTty && current) {
        process.stdout.write('\r' + ' '.repeat(current.length + 4) + '\r');
      }
    },
  };
}
