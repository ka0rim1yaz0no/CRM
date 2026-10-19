export function getRouteLeadTab(value: string) {
  const tabs = {
    all: "ALL", leads: "NEW", new: "NEW", qualified: "Qualified", negotiation: "Ongoing Negotiation",
    "ongoing negotiation": "Ongoing Negotiation", dead: "Dead", archived: "Archived", unassigned: "Unassigned",
    followup: "ALL", "follow up": "ALL",
  } as const;
  const key = value.trim().toLowerCase();
  return Object.hasOwn(tabs, key) ? tabs[key as keyof typeof tabs] : null;
}
