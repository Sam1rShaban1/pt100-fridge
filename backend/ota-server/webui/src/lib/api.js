export async function api(path) {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}
