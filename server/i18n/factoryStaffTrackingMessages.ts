export const factoryStaffTrackingMessages = {
  noFactoryCompany: "No factory company selected",
  invalidPeriod: "Invalid tracking period",
  forbiddenTab: "You do not have access to this Factory tracking tab",
  invalidRecordCount: "records must contain between 1 and 500 rows",
  invalidRow: "Invalid tracking row",
  personOutsideFactory: "Person does not belong to this factory company",
  invalidPersonType: "Invalid person type",
  invalidBaleNumbers: "Target and produced bales must be non-negative numbers",
  duplicatePersonInBatch: "Each worker or employee may appear only once per batch",
} as const;
