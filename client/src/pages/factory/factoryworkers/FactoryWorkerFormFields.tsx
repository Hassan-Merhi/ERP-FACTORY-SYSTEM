import { Check, ChevronsUpDown, PlusCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";

import type { useFactoryWorkersModel } from "./useFactoryWorkersModel";
import { PersonFormSection } from "../people/PersonFormDialog";

interface FactoryWorkersModelProps {
  model: ReturnType<typeof useFactoryWorkersModel>;
}

export function FactoryWorkerFormFields({ model }: FactoryWorkersModelProps) {
  const { formData, nationalityOpen, setNationalityOpen, savedNationalities, updateField } = model;

  return (
    <>
      <PersonFormSection title="Identity">
        <div className="space-y-1">
          <Label className="text-xs">Full Name *</Label>
          <Input
            value={formData.fullName}
            onChange={(e) => updateField("fullName", e.target.value)}
            data-testid="input-fullName"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Father Name</Label>
          <Input
            value={formData.fatherName}
            onChange={(e) => updateField("fatherName", e.target.value)}
            data-testid="input-fatherName"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">National ID</Label>
          <Input
            value={formData.nationalId}
            onChange={(e) => updateField("nationalId", e.target.value)}
            data-testid="input-nationalId"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Passport Number</Label>
          <Input
            value={formData.passportNumber}
            onChange={(e) => updateField("passportNumber", e.target.value)}
            data-testid="input-passportNumber"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Date of Birth</Label>
          <Input
            type="date"
            value={formData.dateOfBirth}
            onChange={(e) => updateField("dateOfBirth", e.target.value)}
            data-testid="input-dateOfBirth"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Gender</Label>
          <Select value={formData.gender} onValueChange={(v) => updateField("gender", v)}>
            <SelectTrigger data-testid="select-gender">
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Male">Male</SelectItem>
              <SelectItem value="Female">Female</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Nationality</Label>
          <Popover open={nationalityOpen} onOpenChange={setNationalityOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                aria-expanded={nationalityOpen}
                className="w-full justify-between font-normal"
                data-testid="input-nationality"
              >
                <span className={formData.nationality ? "" : "text-muted-foreground"}>
                  {formData.nationality || "Select or create…"}
                </span>
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[240px] p-0" align="start">
              <Command>
                <CommandInput
                  placeholder="Search or type new…"
                  value={formData.nationality}
                  onValueChange={(v) => updateField("nationality", v)}
                />
                <CommandList>
                  <CommandEmpty>
                    {formData.nationality.trim() ? (
                      <button
                        className="flex items-center gap-2 px-3 py-2 text-sm w-full hover-elevate text-left"
                        onClick={() => {
                          updateField("nationality", formData.nationality.trim());
                          setNationalityOpen(false);
                        }}
                        data-testid="btn-create-nationality"
                      >
                        <PlusCircle className="h-4 w-4 text-primary" />
                        Create "{formData.nationality.trim()}"
                      </button>
                    ) : (
                      <span className="px-3 py-2 text-xs text-muted-foreground">Type to search or create</span>
                    )}
                  </CommandEmpty>
                  <CommandGroup>
                    {savedNationalities.map((nat) => (
                      <CommandItem
                        key={nat}
                        value={nat}
                        onSelect={() => {
                          updateField("nationality", nat);
                          setNationalityOpen(false);
                        }}
                      >
                        <Check
                          className={`mr-2 h-4 w-4 ${formData.nationality === nat ? "opacity-100" : "opacity-0"}`}
                        />
                        {nat}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Marital Status</Label>
          <Select value={formData.maritalStatus} onValueChange={(v) => updateField("maritalStatus", v)}>
            <SelectTrigger data-testid="select-maritalStatus">
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Single">Single</SelectItem>
              <SelectItem value="Married">Married</SelectItem>
              <SelectItem value="Divorced">Divorced</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </PersonFormSection>
      <PersonFormSection title="Contact">
        <div className="space-y-1">
          <Label className="text-xs">Phone 1</Label>
          <Input
            value={formData.phone1}
            onChange={(e) => updateField("phone1", e.target.value)}
            data-testid="input-phone1"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Phone 2</Label>
          <Input
            value={formData.phone2}
            onChange={(e) => updateField("phone2", e.target.value)}
            data-testid="input-phone2"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Emergency Contact Name</Label>
          <Input
            value={formData.emergencyContactName}
            onChange={(e) => updateField("emergencyContactName", e.target.value)}
            data-testid="input-emergencyContactName"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Emergency Contact Phone</Label>
          <Input
            value={formData.emergencyContactPhone}
            onChange={(e) => updateField("emergencyContactPhone", e.target.value)}
            data-testid="input-emergencyContactPhone"
          />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label className="text-xs">Address</Label>
          <Input
            value={formData.address}
            onChange={(e) => updateField("address", e.target.value)}
            data-testid="input-address"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">City</Label>
          <Input value={formData.city} onChange={(e) => updateField("city", e.target.value)} data-testid="input-city" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Country</Label>
          <Input
            value={formData.country}
            onChange={(e) => updateField("country", e.target.value)}
            data-testid="input-country"
          />
        </div>
      </PersonFormSection>
      <PersonFormSection title="Employment">
        <div className="space-y-1">
          <Label className="text-xs">Position</Label>
          <Input
            value={formData.position}
            onChange={(e) => updateField("position", e.target.value)}
            data-testid="input-position"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Department</Label>
          <Input
            value={formData.department}
            onChange={(e) => updateField("department", e.target.value)}
            data-testid="input-department"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Date Joined</Label>
          <Input
            type="date"
            value={formData.dateJoined}
            onChange={(e) => updateField("dateJoined", e.target.value)}
            data-testid="input-dateJoined"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Contract Start</Label>
          <Input
            type="date"
            value={formData.contractStartDate}
            onChange={(e) => updateField("contractStartDate", e.target.value)}
            data-testid="input-contractStartDate"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Salary Type</Label>
          <Select value={formData.salaryType} onValueChange={(v) => updateField("salaryType", v)}>
            <SelectTrigger data-testid="select-salaryType">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Monthly">Monthly</SelectItem>
              <SelectItem value="Daily">Daily</SelectItem>
              <SelectItem value="Per Bale">Per Bale</SelectItem>
              <SelectItem value="Per KG">Per KG</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Base Salary</Label>
          <Input
            type="number"
            step="0.01"
            value={formData.baseSalary}
            onChange={(e) => updateField("baseSalary", e.target.value)}
            data-testid="input-baseSalary"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Transport Allowance (monthly)</Label>
          <Input
            type="number"
            step="0.01"
            value={formData.transportAllowance}
            onChange={(e) => updateField("transportAllowance", e.target.value)}
            data-testid="input-transportAllowance"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Per Bale Rate</Label>
          <Input
            type="number"
            step="0.0001"
            value={formData.perBaleRate}
            onChange={(e) => updateField("perBaleRate", e.target.value)}
            data-testid="input-perBaleRate"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Per KG Rate</Label>
          <Input
            type="number"
            step="0.0001"
            value={formData.perKgRate}
            onChange={(e) => updateField("perKgRate", e.target.value)}
            data-testid="input-perKgRate"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Pay Frequency</Label>
          <Select value={formData.payFrequency} onValueChange={(v) => updateField("payFrequency", v)}>
            <SelectTrigger data-testid="select-payFrequency">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Monthly">Monthly</SelectItem>
              <SelectItem value="Weekly">Weekly</SelectItem>
              <SelectItem value="Bi-Weekly">Bi-Weekly</SelectItem>
              <SelectItem value="Hourly">Hourly</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {formData.payFrequency === "Weekly" && (
          <div className="space-y-1">
            <Label className="text-xs">Weekly Salary</Label>
            <Input
              type="number"
              step="0.01"
              value={formData.weeklySalary}
              onChange={(e) => updateField("weeklySalary", e.target.value)}
              data-testid="input-weeklySalary"
            />
          </div>
        )}
        {formData.payFrequency === "Bi-Weekly" && (
          <div className="space-y-1">
            <Label className="text-xs">Bi-Weekly Salary</Label>
            <Input
              type="number"
              step="0.01"
              value={formData.biWeeklySalary}
              onChange={(e) => updateField("biWeeklySalary", e.target.value)}
              data-testid="input-biWeeklySalary"
            />
          </div>
        )}
        {formData.payFrequency === "Hourly" && (
          <div className="space-y-1">
            <Label className="text-xs">Hourly Rate</Label>
            <Input
              type="number"
              step="0.0001"
              value={formData.hourlyRate}
              onChange={(e) => updateField("hourlyRate", e.target.value)}
              data-testid="input-hourlyRate"
            />
          </div>
        )}
        <div className="space-y-1">
          <Label className="text-xs">Payment Method</Label>
          <Select value={formData.paymentMethod} onValueChange={(v) => updateField("paymentMethod", v)}>
            <SelectTrigger data-testid="select-paymentMethod">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="Cash">Cash</SelectItem>
              <SelectItem value="Bank">Bank</SelectItem>
              <SelectItem value="Transfer">Transfer</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </PersonFormSection>
      <PersonFormSection title="Documents">
        <div className="space-y-1">
          <Label className="text-xs">Visa Number</Label>
          <Input
            value={formData.visaNumber}
            onChange={(e) => updateField("visaNumber", e.target.value)}
            data-testid="input-visaNumber"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Visa Expiry</Label>
          <Input
            type="date"
            value={formData.visaExpiry}
            onChange={(e) => updateField("visaExpiry", e.target.value)}
            data-testid="input-visaExpiry"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Work Permit No.</Label>
          <Input
            value={formData.workPermitNumber}
            onChange={(e) => updateField("workPermitNumber", e.target.value)}
            data-testid="input-workPermitNumber"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Work Permit Expiry</Label>
          <Input
            type="date"
            value={formData.workPermitExpiry}
            onChange={(e) => updateField("workPermitExpiry", e.target.value)}
            data-testid="input-workPermitExpiry"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Bank Name</Label>
          <Input
            value={formData.bankName}
            onChange={(e) => updateField("bankName", e.target.value)}
            data-testid="input-bankName"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Bank Account No.</Label>
          <Input
            value={formData.bankAccountNumber}
            onChange={(e) => updateField("bankAccountNumber", e.target.value)}
            data-testid="input-bankAccountNumber"
          />
        </div>
      </PersonFormSection>
      <div>
        <h4 className="mb-3 text-sm font-semibold text-muted-foreground">Notes</h4>
        <Textarea
          value={formData.notes}
          onChange={(e) => updateField("notes", e.target.value)}
          rows={3}
          data-testid="input-notes"
        />
      </div>
    </>
  );
}
