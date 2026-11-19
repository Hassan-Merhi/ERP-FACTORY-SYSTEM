// Extracted from ./FactoryDashboard.tsx

export interface DashboardData {
  waste: { totalKg: number; breakdown: Array<{ wasteType: string; kg: number }> };
  workers: { active: number; attendanceToday: number };
  containers: { loaded: number };
}

export interface KpiData {
  openingStockKg: string;
  closingStockKg: string;
  balesPressedToday: number;
  kgsUsedToday: string;
  totalBaleWeightToday: string;
  categories: Array<{ name: string; count: number; totalKg: number }>;
  balesDetail: Array<{
    id: number;
    baleCode: string;
    productName: string;
    category: string;
    weightKg: string;
    pressedAt: string;
    status: string;
    quantity: number;
  }>;
}

export interface Container {
  id: number;
  containerNumber: string;
  supplierName: string | null;
  status: string;
  totalKg: string;
  actualReceivedKg: string | null;
  arrivalDate: string | null;
  origin: string | null;
}
