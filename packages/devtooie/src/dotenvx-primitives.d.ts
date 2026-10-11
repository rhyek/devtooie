// `@dotenvx/primitives` ships no types. This declares the part devtooie uses: the parser that
// `@dotenvx/dotenvx` itself is built on, without the CLI tooling that package loads with it.
declare module '@dotenvx/primitives' {
  interface ParseOptions {
    /** The environment a `${VAR}` reference is looked up in, and whose variables win. */
    processEnv?: Record<string, string | undefined>;
    /** Let the source's values win over `processEnv`'s. */
    overload?: boolean;
  }
  interface ParseResult {
    parsed: Record<string, string>;
    /** Values that could not be decrypted, among other failures. */
    errors: { code: string; message: string }[];
  }
  interface Primitives {
    parseSync(source: string, options?: ParseOptions): ParseResult;
    keypair(): { publicKey: string; privateKey: string };
    encrypt(publicKey: string, value: string): string;
  }
  const primitives: Primitives;
  export default primitives;
}
