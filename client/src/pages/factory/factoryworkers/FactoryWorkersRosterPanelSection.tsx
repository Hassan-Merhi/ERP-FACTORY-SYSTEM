// Extracted from ./FactoryWorkersRosterPanel.tsx to keep that module under the source-size cap.
import { PeopleFilterPanel, PeopleFilterSelect } from "../people/PeopleRoster";
import { SALARY_RANGE_LABELS, useFactoryWorkersRosterPanelState } from "./useFactoryWorkersRosterPanelState";

export function FactoryWorkersRosterPanelSection({
  advanceFilter,
  locationFilter,
  nationalityFilter,
  positionFilter,
  salaryRangeFilter,
  salaryTypeFilter,
  setAdvanceFilter,
  setLocationFilter,
  setNationalityFilter,
  setPositionFilter,
  setSalaryRangeFilter,
  setSalaryTypeFilter,
  setTransportFilter,
  transportFilter,
  uniqueLocations,
  uniqueNationalities,
  uniquePositions,
  uniqueSalaryTypes,
}: Pick<
  ReturnType<typeof useFactoryWorkersRosterPanelState>,
  | "advanceFilter"
  | "locationFilter"
  | "nationalityFilter"
  | "positionFilter"
  | "salaryRangeFilter"
  | "salaryTypeFilter"
  | "setAdvanceFilter"
  | "setLocationFilter"
  | "setNationalityFilter"
  | "setPositionFilter"
  | "setSalaryRangeFilter"
  | "setSalaryTypeFilter"
  | "setTransportFilter"
  | "transportFilter"
  | "uniqueLocations"
  | "uniqueNationalities"
  | "uniquePositions"
  | "uniqueSalaryTypes"
>) {
  return (
    <PeopleFilterPanel>
      <PeopleFilterSelect
        label="Position"
        value={positionFilter}
        onChange={setPositionFilter}
        allLabel="All positions"
        options={uniquePositions.map((value) => ({ value, label: value }))}
      />
      <PeopleFilterSelect
        label="Location"
        value={locationFilter}
        onChange={setLocationFilter}
        allLabel="All locations"
        options={uniqueLocations.map((value) => ({ value, label: value }))}
      />
      <PeopleFilterSelect
        label="Salary Type"
        value={salaryTypeFilter}
        onChange={setSalaryTypeFilter}
        allLabel="All types"
        options={uniqueSalaryTypes.map((value) => ({ value, label: value }))}
      />
      <PeopleFilterSelect
        label="Nationality"
        value={nationalityFilter}
        onChange={setNationalityFilter}
        allLabel="All nationalities"
        options={uniqueNationalities.map((value) => ({ value, label: value }))}
      />
      <PeopleFilterSelect
        label="Salary Range"
        value={salaryRangeFilter}
        onChange={setSalaryRangeFilter}
        allLabel="All ranges"
        options={Object.entries(SALARY_RANGE_LABELS).map(([value, label]) => ({ value, label }))}
      />
      <PeopleFilterSelect
        label="Transport"
        value={transportFilter}
        onChange={setTransportFilter}
        allLabel="All"
        options={[
          { value: "has", label: "Has transport allowance" },
          { value: "none", label: "No transport allowance" },
        ]}
      />
      <PeopleFilterSelect
        label="Advance"
        value={advanceFilter}
        onChange={setAdvanceFilter}
        allLabel="All"
        options={[
          { value: "has", label: "Has outstanding advance" },
          { value: "none", label: "No advance" },
        ]}
      />
    </PeopleFilterPanel>
  );
}
