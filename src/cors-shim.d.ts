declare module "cors" {
  import { RequestHandler } from "express";

  interface CorsOptions {
    origin?: boolean | string | RegExp | Array<boolean | string | RegExp>;
    methods?: string | string[];
    allowedHeaders?: string | string[];
    exposedHeaders?: string | string[];
    credentials?: boolean;
    maxAge?: number;
    preflightContinue?: boolean;
    optionsSuccessStatus?: number;
  }

  export default function cors(options?: CorsOptions): RequestHandler;
}
