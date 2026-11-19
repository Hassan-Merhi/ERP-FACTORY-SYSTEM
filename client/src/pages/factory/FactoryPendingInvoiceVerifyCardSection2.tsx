// Extracted from ./FactoryPendingInvoiceVerifyCardSection.tsx
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Ship } from "lucide-react";
import { useFactoryPendingInvoiceVerifyState } from "./FactoryPendingInvoiceVerifyPageHeaderSection";

export function FactoryPendingInvoiceVerifyCardSection2({
  assignContainerMutation,
  bookingInfo,
  canChange,
  containerNotes,
  containerNumber,
  destination,
  recordChanges,
  setBookingInfo,
  setContainerNotes,
  setContainerNumber,
  setDestination,
  setShippingCompany,
  shippingCompany,
}: Pick<
  ReturnType<typeof useFactoryPendingInvoiceVerifyState>,
  | "assignContainerMutation"
  | "bookingInfo"
  | "canChange"
  | "containerNotes"
  | "containerNumber"
  | "destination"
  | "recordChanges"
  | "setBookingInfo"
  | "setContainerNotes"
  | "setContainerNumber"
  | "setDestination"
  | "setShippingCompany"
  | "shippingCompany"
>) {
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Ship className="h-5 w-5" />
          Container / Shipping
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-sm font-medium mb-1 block">Container Number</label>
            <Input
              value={containerNumber}
              onChange={(e) => setContainerNumber(e.target.value)}
              placeholder="e.g. MSCU1234567"
              data-testid="input-container-number"
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Shipping Company</label>
            <Input
              value={shippingCompany}
              onChange={(e) => setShippingCompany(e.target.value)}
              placeholder="e.g. MSC, Maersk"
              data-testid="input-shipping-company"
            />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Destination</label>
            <Input
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              placeholder="e.g. Rotterdam, UK"
              data-testid="input-destination"
            />
          </div>
        </div>
        <div>
          <label className="text-sm font-medium mb-1 block">Booking Info</label>
          <Input
            type="text"
            value={bookingInfo}
            onChange={(e) => setBookingInfo(e.target.value)}
            placeholder="Quotation price or booking details..."
            data-testid="input-booking-info"
          />
        </div>
        <div>
          <label className="text-sm font-medium mb-1 block">Container Notes</label>
          <Textarea
            value={containerNotes}
            onChange={(e) => setContainerNotes(e.target.value)}
            placeholder="Additional notes..."
            data-testid="input-container-notes"
          />
        </div>
        <Button
          variant="outline"
          onClick={() =>
            assignContainerMutation.mutate({
              containerNumber,
              shippingCompany,
              containerNotes,
              bookingInfo,
              destination,
            })
          }
          disabled={assignContainerMutation.isPending || !canChange}
          title={recordChanges.reason ?? undefined}
          data-testid="button-save-container"
        >
          <Ship className="mr-2 h-4 w-4" />
          Save Container Info
        </Button>
      </CardContent>
    </Card>
  );
}
