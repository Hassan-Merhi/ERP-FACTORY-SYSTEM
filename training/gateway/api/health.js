export default { fetch(request) {
  if (request.method !== "GET") return Response.json({ error: "method" }, { status: 405 });
  return Response.json({ service: "erp-training-storage-gateway", ready: true }, {
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}};
