import type { Request, Response } from "express";
import { Employee } from "../models/Employee";
import { Conversation } from "../models/Conversation";
import { Team } from "../models/Team";

const teamEmployeeFields = "name employeeCode aliases role team company email phone status availabilityStatus";
const populateTeam = [
  { path: "lead", select: teamEmployeeFields },
  { path: "members", select: teamEmployeeFields },
];

type PopulatedTeamEmployee = {
  _id?: unknown;
  status?: string;
};

type PopulatedTeam = {
  lead: PopulatedTeamEmployee | null;
  members: PopulatedTeamEmployee[];
};

async function syncEmployeeTeams(teamId: string, teamName: string, memberIds: string[]) {
  await Employee.updateMany({ team: teamName }, { team: "Unassigned" });

  if (memberIds.length > 0) {
    await Employee.updateMany({ _id: { $in: memberIds } }, { team: teamName });
  }

  return teamId;
}

function conversationMemberIds(memberIds: string[], leadId?: unknown) {
  return Array.from(new Set([...memberIds.map(String), ...(leadId ? [String(leadId)] : [])].filter(Boolean)));
}

async function syncTeamConversation(teamId: string, teamName: string, memberIds: string[], leadId?: unknown) {
  await Conversation.updateMany(
    { type: "team", team: teamId },
    { title: teamName, participants: conversationMemberIds(memberIds, leadId), includeAdmin: true }
  );
}

async function ensureTeamsForAssignedEmployees() {
  const employees = await Employee.find({
    status: { $ne: "Archived" },
    team: { $nin: ["", "Unassigned", null] },
  }).select("_id team company role").lean();
  const grouped = new Map<string, typeof employees>();
  employees.forEach((employee) => grouped.set(employee.team, [...(grouped.get(employee.team) || []), employee]));

  for (const [teamName, members] of grouped) {
    await Team.updateOne(
      { name: teamName },
      {
        $setOnInsert: {
          name: teamName,
          company: members[0]?.company || "All companies",
          department: members[0]?.role || "General",
          lead: null,
          members: members.map((member) => member._id),
          activeLeads: 0,
          status: "Active",
        },
      },
      { upsert: true }
    );
  }
}

export async function listTeams(_request: Request, response: Response) {
  await ensureTeamsForAssignedEmployees();
  const teams = await Team.find({ status: { $ne: "Archived" } })
    .populate(populateTeam)
    .sort({ createdAt: -1 })
    .lean();
  const normalizedTeams = teams.map((team) => {
    const teamObject = team as unknown as PopulatedTeam & Record<string, unknown>;
    const members = Array.isArray(teamObject.members)
      ? teamObject.members.filter((member) => member && member.status !== "Archived")
      : [];

    return {
      ...teamObject,
      lead: teamObject.lead && teamObject.lead.status !== "Archived" ? teamObject.lead : null,
      members,
    };
  });

  response.json(normalizedTeams);
}

export async function createTeam(request: Request, response: Response) {
  const team = await Team.create({
    name: request.body.name,
    company: request.body.company || "All companies",
    department: request.body.department || "General",
    lead: request.body.lead || null,
    members: request.body.members || [],
    activeLeads: request.body.activeLeads || 0,
    status: request.body.status || "Active",
  });

  await syncEmployeeTeams(team.id, team.name, request.body.members || []);
  await syncTeamConversation(team.id, team.name, request.body.members || [], request.body.lead);

  const populatedTeam = await Team.findById(team.id).populate(populateTeam).lean();
  response.status(201).json(populatedTeam);
}

export async function updateTeam(request: Request, response: Response) {
  const teamId = String(request.params.id);
  const existingTeam = await Team.findById(teamId);

  if (!existingTeam) {
    response.status(404).json({ message: "Team not found" });
    return;
  }

  const team = await Team.findByIdAndUpdate(
    teamId,
    {
      name: request.body.name,
      company: request.body.company || "All companies",
      department: request.body.department || "General",
      lead: request.body.lead || null,
      members: request.body.members || [],
      activeLeads: request.body.activeLeads || 0,
      status: request.body.status || "Active",
    },
    { returnDocument: "after", runValidators: true }
  ).populate(populateTeam).lean();

  await Employee.updateMany({ team: existingTeam.name }, { team: "Unassigned" });
  await syncEmployeeTeams(teamId, request.body.name, request.body.members || []);
  await syncTeamConversation(teamId, request.body.name, request.body.members || [], request.body.lead);

  response.json(team);
}

export async function archiveTeam(request: Request, response: Response) {
  const teamId = String(request.params.id);
  const team = await Team.findByIdAndUpdate(
    teamId,
    {
      status: "Archived",
      members: [],
      lead: null,
    },
    { returnDocument: "after", runValidators: true }
  ).populate(populateTeam).lean();

  if (!team) {
    response.status(404).json({ message: "Team not found" });
    return;
  }

  await Employee.updateMany({ team: team.name }, { team: "Unassigned" });
  await Conversation.updateMany({ type: "team", team: teamId }, { participants: [], title: team.name });

  response.json(team);
}
