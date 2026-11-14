import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { spreadsheetUpload } from "../server/routes/helpers/uploadHelpers";

describe("multipart spreadsheet upload", () => {
  it("accepts two independent spreadsheets on validation routes", async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.session = { currentRole: "User" } as typeof req.session;
      next();
    });
    app.post("/validation", spreadsheetUpload.fields([
      { name: "file1", maxCount: 1 },
      { name: "file2", maxCount: 1 },
    ]), (req, res) => {
      const files = req.files as Record<string, Express.Multer.File[]>;
      res.json({ file1: files.file1[0].originalname, file2: files.file2[0].originalname });
    });
    const response = await request(app).post("/validation")
      .attach("file1", Buffer.from("a"), "first.csv")
      .attach("file2", Buffer.from("b"), "second.csv");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ file1: "first.csv", file2: "second.csv" });
  });
});
