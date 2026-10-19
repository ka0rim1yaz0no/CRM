export function employeeBusinessDestination(pathname: string, search: string) {
  if (pathname === "/profile") {
    const tab = new URLSearchParams(search).get("tab");
    return ["overview", "leave", "notices"].includes(tab || "") ? `/profile?tab=${tab}` : "/profile";
  }
  return ["/dashboard", "/attendance", "/settings"].includes(pathname) ? pathname : "/dashboard";
}
