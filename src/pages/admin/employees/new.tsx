import type { ChangeEvent, FormEvent, KeyboardEvent, RefObject } from "react";
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import { FiArrowLeft, FiCamera, FiPlus, FiSave, FiX } from "react-icons/fi";
import AdminLayout from "../adminLayout";
import { getBusinesses } from "../../../api/businesses";
import { getActiveBusinessId } from "../../../api/businessStorage";
import {
    createEmployee,
    type EmployeeInput,
    type EmployeeStatus,
} from "../../../api/employees";
import { getRoles } from "../../../api/roles";
import { useToast } from "../../../components/ToastProvider";
import { roleWorkspacePath } from "../../../lib/roleAccess";

const fallbackRoles = ["Sales Agent", "Team Lead", "Manager", "Support Agent"];
const employmentStatuses: EmployeeStatus[] = ["Active", "Training", "Paused", "Archived"];

const emptyEmployee: EmployeeInput = {
    name: "",
    dateHired: "",
    employeeCode: "",
    aliases: [],
    role: "Sales Agent",
    team: "Unassigned",
    company: "Assistly",
    email: "",
    phone: "",
    profileImage: "",
    personalPhone: "",
    personalEmail: "",
    personalAddress: "",
    emergencyContact: "",
    personalNotes: "",
    bankName: "",
    bankAccountName: "",
    bankAccountNumber: "",
    bankRoutingNumber: "",
    salary: 0,
    status: "Active",
    availabilityStatus: "OFFLINE",
    businessAccessIds: [],
};

function digitsOnly(value = "") {
    return value.replace(/\D/g, "");
}

function employeeInitials(name = "") {
    return name
        .split(" ")
        .filter(Boolean)
        .map((part) => part[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();
}

function formatPhoneWithExtension(areaCode: string, operatorCode: string, mobileNumber: string, extension: string) {
    const cleanNumber = [areaCode, operatorCode, mobileNumber].map((part) => part.trim()).filter(Boolean).join(" ");
    const cleanExtension = extension.trim();
    if (!cleanExtension) return cleanNumber;
    return `${cleanNumber} Ext. ${cleanExtension}`;
}

export default function AdminEmployeeNew() {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { showToast } = useToast();
    const phoneOperatorCodeRef = useRef<HTMLInputElement>(null);
    const phoneMobileNumberRef = useRef<HTMLInputElement>(null);
    const phoneExtensionRef = useRef<HTMLInputElement>(null);
    const profileImageInputRef = useRef<HTMLInputElement>(null);
    const [employee, setEmployee] = useState<EmployeeInput>(() => ({
        ...emptyEmployee,
        businessAccessIds: getActiveBusinessId() ? [getActiveBusinessId()] : [],
    }));
    const [phoneOperatorCode, setPhoneOperatorCode] = useState("");
    const [phoneMobileNumber, setPhoneMobileNumber] = useState("");
    const [phoneExtension, setPhoneExtension] = useState("");

    const { data: roleRecords = [] } = useQuery({
        queryKey: ["roles"],
        queryFn: getRoles,
    });
    const { data: businesses = [] } = useQuery({
        queryKey: ["businesses"],
        queryFn: getBusinesses,
        staleTime: Number.POSITIVE_INFINITY,
    });

    const roleOptions = useMemo(
        () => {
            const activeRoles = roleRecords.filter((role) => !role.isArchived).map((role) => role.name);
            return Array.from(new Set([employee.role, ...(activeRoles.length ? activeRoles : fallbackRoles)].filter(Boolean)));
        },
        [employee.role, roleRecords],
    );

    const departmentOptions = useMemo(
        () =>
            Array.from(
                new Set([
                    employee.team,
                    ...roleRecords.filter((role) => !role.isArchived).map((role) => role.department || "General"),
                    "Unassigned",
                    "General",
                    "Sales",
                    "Operations",
                    "Support",
                ].filter(Boolean)),
            ),
        [employee.team, roleRecords],
    );

    const createMutation = useMutation({
        mutationFn: createEmployee,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["employees"] });
            showToast({ tone: "success", message: "Employee added." });
            navigate(roleWorkspacePath("/admin/employees"));
        },
        onError: () => {
            showToast({ tone: "error", message: "Could not add employee." });
        },
    });

    const updateEmployeeForm = <Field extends keyof EmployeeInput>(field: Field, value: EmployeeInput[Field]) => {
        setEmployee((currentEmployee) => ({ ...currentEmployee, [field]: value }));
    };

    const syncPhoneForm = (operatorCode: string, mobileNumber: string, extension = phoneExtension) => {
        const areaCode = operatorCode || mobileNumber ? "63" : "";
        updateEmployeeForm("phone", formatPhoneWithExtension(areaCode, operatorCode, mobileNumber, extension));
    };

    const toggleBusinessAccess = (businessId: string) => {
        setEmployee((currentEmployee) => {
            const selectedBusinessIds = new Set(currentEmployee.businessAccessIds || []);

            if (selectedBusinessIds.has(businessId)) {
                selectedBusinessIds.delete(businessId);
            } else {
                selectedBusinessIds.add(businessId);
            }

            const activeBusinessId = getActiveBusinessId();
            if (activeBusinessId) {
                selectedBusinessIds.add(activeBusinessId);
            }

            return { ...currentEmployee, businessAccessIds: Array.from(selectedBusinessIds) };
        });
    };

    const focusNextPhoneInput = (ref: RefObject<HTMLInputElement | null>) => {
        window.requestAnimationFrame(() => {
            ref.current?.focus();
            ref.current?.setSelectionRange(ref.current.value.length, ref.current.value.length);
        });
    };

    const updatePhoneSegment = (segment: "operator" | "mobile", value: string) => {
        const digits = digitsOnly(value);
        let nextOperatorCode = phoneOperatorCode;
        let nextMobileNumber = phoneMobileNumber;

        if (segment === "operator") {
            const normalizedDigits = digits.startsWith("63") && digits.length > 3
                ? digits.slice(2)
                : digits.startsWith("0") && digits.length > 1
                    ? digits.slice(1)
                    : digits;
            nextOperatorCode = normalizedDigits.slice(0, 3);
            const overflow = normalizedDigits.slice(3);
            if (overflow) {
                nextMobileNumber = overflow;
            }
            if (normalizedDigits.length >= 3) {
                focusNextPhoneInput(phoneMobileNumberRef);
            }
        }

        if (segment === "mobile") {
            nextMobileNumber = digits;
        }

        setPhoneOperatorCode(nextOperatorCode);
        setPhoneMobileNumber(nextMobileNumber);
        syncPhoneForm(nextOperatorCode, nextMobileNumber);
    };

    const handlePhoneSegmentKeyDown = (
        event: KeyboardEvent<HTMLInputElement>,
        nextRef?: RefObject<HTMLInputElement | null>,
        previousRef?: RefObject<HTMLInputElement | null>,
    ) => {
        if (event.key === "Enter" && nextRef) {
            event.preventDefault();
            focusNextPhoneInput(nextRef);
        }

        if (event.key === "Backspace" && !event.currentTarget.value && previousRef) {
            event.preventDefault();
            focusNextPhoneInput(previousRef);
        }
    };

    const updateProfileImage = (file: File | undefined) => {
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            updateEmployeeForm("profileImage", String(reader.result || ""));
        };
        reader.readAsDataURL(file);
    };

    const handleRoleChange = (roleName: string) => {
        const matchedRole = roleRecords.find((role) => role.name === roleName);
        setEmployee((currentEmployee) => ({
            ...currentEmployee,
            role: roleName,
            team: matchedRole?.department || currentEmployee.team || "Unassigned",
        }));
    };

    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        createMutation.mutate({
            ...employee,
            phone: formatPhoneWithExtension(phoneOperatorCode || phoneMobileNumber ? "63" : "", phoneOperatorCode, phoneMobileNumber, phoneExtension),
        });
    };

    const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
        updateProfileImage(event.target.files?.[0]);
        event.target.value = "";
    };

    const inputClass = "mt-2 h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20";
    const textareaClass = "mt-2 min-h-24 w-full resize-none rounded-lg border border-slate-300 bg-white p-3 text-sm font-semibold text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20";
    const labelClass = "text-xs font-semibold uppercase tracking-[0.14em] text-slate-500";

    return (
        <AdminLayout>
            <section className="min-h-[calc(100vh-8.5rem)] space-y-4 text-slate-950">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-300 pb-4">
                    <div>
                        <Link
                            className="inline-flex items-center gap-2 text-sm font-semibold text-slate-600 transition hover:text-slate-950"
                            to={roleWorkspacePath("/admin/employees")}
                        >
                            <FiArrowLeft className="size-4" aria-hidden="true" />
                            Back to employees
                        </Link>
                        <p className="mt-4 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Admin Employees</p>
                        <h2 className="mt-1 text-2xl font-semibold text-slate-950">Add Employee</h2>
                    </div>
                    <div className="rounded-lg border border-[#842cff]/20 bg-[#842cff]/10 px-3 py-2 text-sm font-semibold text-[#5f27cd]">
                        New Profile
                    </div>
                </div>

                <form
                    className="overflow-hidden rounded-lg border border-slate-300 bg-white shadow-lg shadow-slate-950/10"
                    onSubmit={handleSubmit}
                >
                    <div className="grid gap-5 p-6 lg:grid-cols-2 2xl:p-7">
                        <div className="lg:col-span-2 rounded-lg border border-slate-300 bg-slate-50 p-4">
                            <div className="flex flex-wrap items-center gap-4">
                                <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[#842cff]/30 bg-[#842cff]/10 text-lg font-bold text-[#5f27cd]">
                                    {employee.profileImage ? (
                                        <img className="size-full object-cover" src={employee.profileImage} alt={employee.name || "Employee"} />
                                    ) : (
                                        employeeInitials(employee.name) || "EP"
                                    )}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <p className={labelClass}>Profile Picture</p>
                                    <div className="mt-2 flex flex-wrap gap-2">
                                        <button
                                            className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-100"
                                            type="button"
                                            onClick={() => profileImageInputRef.current?.click()}
                                        >
                                            <FiCamera className="size-3.5" aria-hidden="true" />
                                            Choose Photo
                                        </button>
                                        {employee.profileImage && (
                                            <button
                                                className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-600 transition hover:bg-slate-100"
                                                type="button"
                                                onClick={() => updateEmployeeForm("profileImage", "")}
                                            >
                                                <FiX className="size-3.5" aria-hidden="true" />
                                                Remove
                                            </button>
                                        )}
                                    </div>
                                </div>
                                <input
                                    ref={profileImageInputRef}
                                    className="hidden"
                                    type="file"
                                    accept="image/*"
                                    onChange={handleFileChange}
                                />
                            </div>
                        </div>

                        <label className="lg:col-span-2">
                            <span className={labelClass}>Full Name</span>
                            <input
                                className={inputClass}
                                value={employee.name}
                                onChange={(event) => updateEmployeeForm("name", event.target.value)}
                                placeholder="Employee name"
                            />
                        </label>

                        <label className="lg:col-span-2">
                            <span className={labelClass}>Date Hired</span>
                            <input
                                className={inputClass}
                                type="date"
                                value={employee.dateHired}
                                onChange={(event) => updateEmployeeForm("dateHired", event.target.value)}
                            />
                        </label>

                        <label>
                            <span className={labelClass}>Department</span>
                            <select
                                className={inputClass}
                                value={employee.team}
                                onChange={(event) => updateEmployeeForm("team", event.target.value)}
                            >
                                {departmentOptions.map((department) => (
                                    <option key={department} value={department}>
                                        {department}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label>
                            <span className={labelClass}>Role</span>
                            <select
                                className={inputClass}
                                value={employee.role}
                                onChange={(event) => handleRoleChange(event.target.value)}
                            >
                                {roleOptions.map((role) => (
                                    <option key={role} value={role}>
                                        {role}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label>
                            <span className={labelClass}>Employment Status</span>
                            <select
                                className={inputClass}
                                value={employee.status}
                                onChange={(event) => updateEmployeeForm("status", event.target.value as EmployeeStatus)}
                            >
                                {employmentStatuses.map((status) => (
                                    <option key={status} value={status}>
                                        {status}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label>
                            <span className={labelClass}>Company</span>
                            <input
                                className={inputClass}
                                value={employee.company || ""}
                                onChange={(event) => updateEmployeeForm("company", event.target.value)}
                                placeholder="Assistly"
                            />
                        </label>

                        {businesses.length > 0 && (
                            <fieldset className="lg:col-span-2 rounded-lg border border-slate-300 bg-slate-50 p-4">
                                <legend className={labelClass}>Business Access</legend>
                                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                    {businesses.map((business) => {
                                        const isActiveBusiness = business.id === getActiveBusinessId();
                                        const isChecked = (employee.businessAccessIds || []).includes(business.id);

                                        return (
                                            <label
                                                key={business.id}
                                                className={[
                                                    "flex min-h-11 items-center gap-3 rounded-lg border bg-white px-3 py-2 text-sm font-semibold transition",
                                                    isChecked ? "border-[#842cff]/40 text-[#5f27cd]" : "border-slate-300 text-slate-700",
                                                ].join(" ")}
                                            >
                                                <input
                                                    className="size-4 accent-[#842cff]"
                                                    type="checkbox"
                                                    checked={isChecked}
                                                    disabled={isActiveBusiness}
                                                    onChange={() => toggleBusinessAccess(business.id)}
                                                />
                                                <span className="min-w-0 flex-1 truncate">{business.name}</span>
                                                {isActiveBusiness && <span className="text-xs text-slate-400">Current</span>}
                                            </label>
                                        );
                                    })}
                                </div>
                            </fieldset>
                        )}

                        <label>
                            <span className={labelClass}>Employee Code</span>
                            <input
                                className={inputClass}
                                value={employee.employeeCode}
                                onChange={(event) => updateEmployeeForm("employeeCode", event.target.value)}
                                placeholder="EMP-1001"
                            />
                        </label>

                        <label>
                            <span className={labelClass}>Email</span>
                            <input
                                className={inputClass}
                                type="email"
                                value={employee.email}
                                onChange={(event) => updateEmployeeForm("email", event.target.value)}
                                placeholder="employee@assistly.com"
                            />
                        </label>

                        <label className="lg:col-span-2">
                            <span className={labelClass}>Aliases</span>
                            <textarea
                                className={textareaClass}
                                value={(employee.aliases || []).join(", ")}
                                onChange={(event) =>
                                    updateEmployeeForm(
                                        "aliases",
                                        event.target.value
                                            .split(",")
                                            .map((alias) => alias.trim())
                                            .filter(Boolean),
                                    )
                                }
                                placeholder="Marcus, Marc, M"
                            />
                        </label>

                        <div>
                            <span className={labelClass}>Mobile Number</span>
                            <div className="mt-2 grid grid-cols-[0.9fr_1.7fr] gap-2">
                                <label>
                                    <span className="mb-1 block text-[0.66rem] font-semibold uppercase tracking-[0.12em] text-slate-500">Operator</span>
                                    <input
                                        ref={phoneOperatorCodeRef}
                                        className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        inputMode="numeric"
                                        value={phoneOperatorCode}
                                        onChange={(event) => updatePhoneSegment("operator", event.target.value)}
                                        onKeyDown={(event) => handlePhoneSegmentKeyDown(event, phoneMobileNumberRef)}
                                        placeholder="960"
                                    />
                                </label>
                                <label>
                                    <span className="mb-1 block text-[0.66rem] font-semibold uppercase tracking-[0.12em] text-slate-500">Number</span>
                                    <input
                                        ref={phoneMobileNumberRef}
                                        className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-[#842cff] focus:ring-2 focus:ring-[#842cff]/20"
                                        inputMode="numeric"
                                        value={phoneMobileNumber}
                                        onChange={(event) => updatePhoneSegment("mobile", event.target.value)}
                                        onKeyDown={(event) => handlePhoneSegmentKeyDown(event, phoneExtensionRef, phoneOperatorCodeRef)}
                                        placeholder="3877103"
                                    />
                                </label>
                            </div>
                        </div>

                        <label>
                            <span className={labelClass}>Extension</span>
                            <input
                                ref={phoneExtensionRef}
                                className={inputClass}
                                inputMode="numeric"
                                value={phoneExtension}
                                onChange={(event) => {
                                    const extension = digitsOnly(event.target.value);
                                    setPhoneExtension(extension);
                                    updateEmployeeForm("phone", formatPhoneWithExtension(phoneOperatorCode || phoneMobileNumber ? "63" : "", phoneOperatorCode, phoneMobileNumber, extension));
                                }}
                                placeholder="1005"
                            />
                        </label>

                        <label>
                            <span className={labelClass}>Monthly Salary</span>
                            <input
                                className={inputClass}
                                type="number"
                                min="0"
                                step="0.01"
                                value={employee.salary}
                                onChange={(event) => updateEmployeeForm("salary", Number(event.target.value))}
                                placeholder="5000"
                            />
                        </label>

                        <div className="lg:col-span-2 border-t border-slate-200 pt-5">
                            <p className={labelClass}>HR Personal Info</p>
                        </div>

                        <label>
                            <span className={labelClass}>Personal Phone</span>
                            <input
                                className={inputClass}
                                value={employee.personalPhone || ""}
                                onChange={(event) => updateEmployeeForm("personalPhone", event.target.value)}
                                placeholder="Personal mobile"
                            />
                        </label>

                        <label>
                            <span className={labelClass}>Personal Email</span>
                            <input
                                className={inputClass}
                                type="email"
                                value={employee.personalEmail || ""}
                                onChange={(event) => updateEmployeeForm("personalEmail", event.target.value)}
                                placeholder="personal@email.com"
                            />
                        </label>

                        <label className="lg:col-span-2">
                            <span className={labelClass}>Personal Address</span>
                            <textarea
                                className={textareaClass}
                                value={employee.personalAddress || ""}
                                onChange={(event) => updateEmployeeForm("personalAddress", event.target.value)}
                                placeholder="Home address"
                            />
                        </label>

                        <label className="lg:col-span-2">
                            <span className={labelClass}>Emergency Contact</span>
                            <input
                                className={inputClass}
                                value={employee.emergencyContact || ""}
                                onChange={(event) => updateEmployeeForm("emergencyContact", event.target.value)}
                                placeholder="Name, relationship, phone"
                            />
                        </label>

                        <label className="lg:col-span-2">
                            <span className={labelClass}>Personal Notes</span>
                            <textarea
                                className={textareaClass}
                                value={employee.personalNotes || ""}
                                onChange={(event) => updateEmployeeForm("personalNotes", event.target.value)}
                                placeholder="Private HR notes"
                            />
                        </label>

                        <div className="lg:col-span-2 border-t border-slate-200 pt-5">
                            <p className={labelClass}>Bank Details</p>
                        </div>
                        {[
                            ["Bank Name", "bankName", "Bank or financial institution"],
                            ["Account Name", "bankAccountName", "Name on the account"],
                            ["Account Number", "bankAccountNumber", "Account number"],
                        ].map(([label, field, placeholder]) => (
                            <label key={field}>
                                <span className={labelClass}>{label}</span>
                                <input
                                    className={inputClass}
                                    value={String(employee[field as keyof EmployeeInput] || "")}
                                    onChange={(event) => updateEmployeeForm(field as keyof EmployeeInput, event.target.value)}
                                    inputMode={field.includes("Number") ? "numeric" : undefined}
                                    autoComplete="off"
                                    placeholder={placeholder}
                                />
                            </label>
                        ))}
                    </div>

                    <div className="flex flex-wrap justify-end gap-3 border-t border-slate-200 px-6 py-4">
                        <Link
                            className="inline-flex h-10 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
                            to={roleWorkspacePath("/admin/employees")}
                        >
                            Cancel
                        </Link>
                        <button
                            className="admin-employees-primary-button inline-flex h-10 items-center gap-2 rounded-lg bg-[linear-gradient(135deg,#842cff,#4a0ebd)] px-4 text-sm font-semibold !text-white transition hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-[#842cff]/60 disabled:cursor-not-allowed disabled:opacity-60"
                            style={{ color: "#ffffff" }}
                            type="submit"
                            disabled={createMutation.isPending}
                        >
                            {createMutation.isPending ? (
                                <FiSave className="size-4 !text-white" aria-hidden="true" />
                            ) : (
                                <FiPlus className="size-4 !text-white" aria-hidden="true" />
                            )}
                            <span className="!text-white">{createMutation.isPending ? "Saving..." : "Add Employee"}</span>
                        </button>
                    </div>
                </form>
            </section>
        </AdminLayout>
    );
}
