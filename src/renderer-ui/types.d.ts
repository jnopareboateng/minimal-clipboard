export {};

type LocalRequire = (module: string) => any;

declare global {
  interface Window {
    require?: LocalRequire;
  }
}
