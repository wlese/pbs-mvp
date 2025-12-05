declare module "pdf-parse" {
  export interface PDFParseResult {
    numpages: number;
    numrender: number;
    info: any;
    metadata: any;
    text: string;
    version: string;
  }

  export interface PDFParseOptions {
    pagerender?: (pageData: any) => any;
    max?: number;
    version?: string;
  }

  export default function pdfParse(
    data: Buffer | Uint8Array | ArrayBuffer | string,
    options?: PDFParseOptions,
  ): Promise<PDFParseResult>;
}
