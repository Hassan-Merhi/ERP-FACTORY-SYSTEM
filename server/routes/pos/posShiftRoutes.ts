import { type Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import { userLocations } from "@shared/schema";
import { eq, and } from "drizzle-orm";

export function registerPosShiftRoutes(app: Express): void {
  // POS Shift Management Routes
  // Get current open shift for user at location
  app.get("/api/pos/shifts/current", requireAuth, async (req, res) => {
    try {
      const locationId = parseInt(req.query.locationId as string);
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({ message: "User not authenticated" });
      }
      if (!locationId || isNaN(locationId)) {
        return res.status(400).json({ message: "Location ID is required" });
      }

      // Verify location belongs to current company
      const location = await storage.getLocationById(locationId);
      if (!location || location.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({ message: "Access denied" });
      }

      const shift = await storage.getCurrentShift(userId, locationId);
      res.json(shift || null);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get shift history for a location
  app.get("/api/pos/shifts/history", requireAuth, async (req, res) => {
    try {
      const locationId = parseInt(req.query.locationId as string);
      const limit = parseInt(req.query.limit as string) || 50;

      if (!locationId || isNaN(locationId)) {
        return res.status(400).json({ message: "Location ID is required" });
      }

      // Verify location belongs to current company
      const location = await storage.getLocationById(locationId);
      if (!location || location.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({ message: "Access denied" });
      }

      let shifts = await storage.getShiftsByLocation(locationId, limit);
      // POS users can only see their own shifts
      if (req.user?.role === "POS") {
        const posUserId = req.user.id;
        shifts = shifts.filter((s) => s.userId === posUserId);
      }
      res.json(shifts);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get shift by ID with report data
  app.get("/api/pos/shifts/:id", requireAuth, async (req, res) => {
    try {
      const shiftId = parseInt(req.params.id);
      const shift = await storage.getShiftById(shiftId);

      if (!shift) {
        return res.status(404).json({ message: "Shift not found" });
      }

      // Verify shift belongs to current company
      if (shift.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({ message: "Access denied" });
      }

      // POS users can only access their own shifts
      if (req.user?.role === "POS" && shift.userId !== req.user.id) {
        return res.status(403).json({ message: "Access denied" });
      }

      res.json(shift);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Open a new shift
  app.post("/api/pos/shifts/open", requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      const username = req.user?.username;

      if (!userId || !username) {
        return res.status(401).json({ message: "User not authenticated" });
      }
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { locationId, cashAccountId, openingCash, posStation } = req.body;

      if (!locationId) {
        return res.status(400).json({ message: "Location is required" });
      }

      // Verify location belongs to current company
      const location = await storage.getLocationById(locationId);
      if (!location || location.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({ message: "Access denied: Invalid location" });
      }

      // POS users may only open shifts at their assigned location(s)
      if (req.user?.role === "POS") {
        const assignedLocs = await db
          .select({ locationId: userLocations.locationId })
          .from(userLocations)
          .where(and(eq(userLocations.userId, req.user.id), eq(userLocations.companyId, req.session.currentCompanyId!)));
        const allowedIds = assignedLocs.map((l) => l.locationId);
        if (!allowedIds.includes(locationId)) {
          return res.status(403).json({ message: "You can only open shifts at your assigned location" });
        }
      }

      // Check if user already has an open shift at this location
      const existingShift = await storage.getCurrentShift(userId, locationId);
      if (existingShift) {
        return res.status(400).json({
          message: "You already have an open shift at this location. Please close it first.",
          existingShiftId: existingShift.id,
        });
      }

      const shift = await storage.openShift({
        companyId: req.session.currentCompanyId,
        locationId,
        userId,
        username,
        cashAccountId: cashAccountId || null,
        posStation: posStation || null,
        openingCash: openingCash || "0",
        status: "open",
      });

      res.json(shift);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Close a shift
  app.post("/api/pos/shifts/:id/close", requireAuth, async (req, res) => {
    try {
      const shiftId = parseInt(req.params.id);
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({ message: "User not authenticated" });
      }

      const shift = await storage.getShiftById(shiftId);
      if (!shift) {
        return res.status(404).json({ message: "Shift not found" });
      }

      // Verify user owns this shift and it belongs to current company
      if (shift.userId !== userId) {
        return res.status(403).json({ message: "You can only close your own shifts" });
      }
      if (shift.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({ message: "Access denied" });
      }

      if (shift.status === "closed") {
        return res.status(400).json({ message: "Shift is already closed" });
      }

      const { closingCash, notes } = req.body;

      if (closingCash === undefined || closingCash === null) {
        return res.status(400).json({ message: "Closing cash amount is required" });
      }

      const closedShift = await storage.closeShift(shiftId, closingCash.toString(), notes);
      res.json(closedShift);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
