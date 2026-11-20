import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";

export function authenticate(request: Request, response: Response, next: NextFunction): void {
  if (config.authMode === "none") {
    next();
    return;
  }

  const authorization = request.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  const supplied = match?.[1] ?? "";
  const expectedBuffer = Buffer.from(config.authToken);
  const suppliedBuffer = Buffer.from(supplied);

  const valid = suppliedBuffer.length === expectedBuffer.length
    && timingSafeEqual(suppliedBuffer, expectedBuffer);

  if (!valid) {
    response.setHeader("WWW-Authenticate", "Bearer");
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}
