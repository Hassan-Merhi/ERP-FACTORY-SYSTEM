import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { generalUpload } from "../server/routes/helpers/uploadHelpers";

describe("general file upload guards", () => {
  it("returns a clear 413 for images over 10 MiB", async () => {
    const app = express();
    app.post("/upload", generalUpload.single("file"), (req, res) => {
      res.json({ fileName: req.file?.originalname });
    });
    const response = await request(app).post("/upload").attach("file", Buffer.alloc(10 * 1024 * 1024 + 1), {
      filename: "oversized.jpg",
      contentType: "image/jpeg",
    });
    expect(response.status).toBe(413);
    expect(response.body.code).toBe("UPLOAD_FILE_TOO_LARGE");
    expect(response.body.message).toContain("10 MB");
  });

  it("accepts a small PDF upload", async () => {
    const app = express();
    app.post("/upload", generalUpload.single("file"), (req, res) => {
      res.json({ size: req.file?.size });
    });
    const response = await request(app).post("/upload").attach("file", Buffer.from("sample"), {
      filename: "invoice.pdf",
      contentType: "application/pdf",
    });
    expect(response.status).toBe(200);
    expect(response.body.size).toBe(6);
  });
});
