// Minimal ambient declarations for the plugin globals used in code.ts.
// Replaceable with @figma/plugin-typings, which is not installed in this repo.

declare const __html__: string;

declare const figma: {
  readonly root: { readonly name: string; readonly children: readonly unknown[] };
  readonly currentPage: { readonly id: string };
  readonly fileKey?: string;
  readonly editorType: string;
  readonly ui: {
    postMessage(message: unknown): void;
    onmessage: ((message: unknown) => void) | undefined;
  };
  readonly variables: {
    getLocalVariablesAsync(): Promise<readonly unknown[]>;
    getLocalVariableCollectionsAsync(): Promise<readonly unknown[]>;
    getVariableByIdAsync(id: string): Promise<unknown>;
    getVariableCollectionByIdAsync(id: string): Promise<unknown>;
  };
  showUI(html: string, options?: { width?: number; height?: number; themeColors?: boolean }): void;
  closePlugin(): void;
  getImageByHash(hash: string): unknown;
  base64Encode(bytes: Uint8Array): string;
  getLocalPaintStylesAsync(): Promise<readonly unknown[]>;
  getLocalTextStylesAsync(): Promise<readonly unknown[]>;
  getLocalEffectStylesAsync(): Promise<readonly unknown[]>;
  getLocalGridStylesAsync(): Promise<readonly unknown[]>;
};
