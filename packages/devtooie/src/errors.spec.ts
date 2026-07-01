import { describe, it, expect, vi } from 'vitest';
import { handleShellError } from './errors.js';

describe('handleShellError', () => {
  it('prints stderr and exits with the error exitCode', () => {
    const err = { stderr: 'boom', exitCode: 7 };
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const errLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => handleShellError(err)).toThrow('exit');
    expect(errLog).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(exit).toHaveBeenCalledWith(7);
    exit.mockRestore();
    errLog.mockRestore();
  });

  it('defaults exit code to 1', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => handleShellError({ stdout: 'x' })).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });
});
