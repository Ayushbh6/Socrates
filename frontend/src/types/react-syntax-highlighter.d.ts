declare module "react-syntax-highlighter" {
  import type { ComponentType, ReactNode } from "react";

  export type SyntaxHighlighterProps = {
    children?: ReactNode;
    language?: string;
    style?: object;
    customStyle?: object;
    codeTagProps?: object;
    wrapLongLines?: boolean;
  };

  export const Prism: ComponentType<SyntaxHighlighterProps>;
}

declare module "react-syntax-highlighter/dist/esm/styles/prism" {
  export const oneDark: object;
}
