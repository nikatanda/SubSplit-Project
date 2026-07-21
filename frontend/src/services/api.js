const API_BASE = import.meta.env.VITE_API_URL || "/api";

export async function apiFetch(path, options = {}) {
  const token = localStorage.getItem("subsplit_token");
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
    ...options,
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message || "Request failed"), body);
  return body;
}

export const post = (path, data) => apiFetch(path, { method: "POST", body: JSON.stringify(data) });
export const patch = (path, data) => apiFetch(path, { method: "PATCH", body: JSON.stringify(data) });
export const put = (path, data) => apiFetch(path, { method: "PUT", body: JSON.stringify(data) });
