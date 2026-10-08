import { useEffect, useState, type FormEvent } from "react";
import { FiAlertCircle, FiArrowRight, FiCheckCircle, FiExternalLink } from "react-icons/fi";
import registerToVoteImage from "../../assets/register-to-vote.png";
import {
  submitHempIndustrySurvey,
  SurveySubmissionError,
  type HempIndustrySurveyInput,
} from "../../api/surveys";

const hempUseOptions = ["Pain", "Stress", "Anxiety", "Recreational", "Relaxation", "Other"];

type SurveyForm = Omit<HempIndustrySurveyInput, "age" | "joinsHempPetition" | "consentToUpdates"> & {
  age: string;
  joinsHempPetition: "yes" | "no" | "";
  consentToUpdates: "yes" | "no" | "";
  hempUseOther: string;
};

const initialForm: SurveyForm = {
  firstName: "",
  lastName: "",
  age: "",
  city: "",
  county: "",
  mobileNumber: "",
  email: "",
  joinsHempPetition: "",
  consentToUpdates: "",
  hempUse: "",
  hempUseOther: "",
  storeName: "",
  companyWebsite: "",
};

const fieldClass = "mt-2.5 h-12 w-full rounded-md border border-[#c4cec8] bg-white px-3.5 text-[15px] text-[#18211d] outline-none transition placeholder:text-[#82908a] hover:border-[#9eafa6] focus:border-[#266c4d] focus:ring-2 focus:ring-[#266c4d]/15";

export default function HempIndustrySurvey() {
  const [form, setForm] = useState<SurveyForm>(initialForm);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Help Save the Hemp Industry | Assistly";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  function updateField<Key extends keyof SurveyForm>(key: Key, value: SurveyForm[Key]) {
    setForm((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[key];
      if (key === "hempUse") delete next.hempUseOther;
      if (key === "hempUseOther") delete next.hempUse;
      return next;
    });
    setSubmitError("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (form.hempUse === "Other" && !form.hempUseOther.trim()) {
      setFieldErrors((current) => ({ ...current, hempUseOther: "Describe what you use hemp for." }));
      return;
    }

    setIsSubmitting(true);
    setSubmitError("");
    setFieldErrors({});

    try {
      const { hempUseOther, ...submissionFields } = form;
      const result = await submitHempIndustrySurvey({
        ...submissionFields,
        age: Number(form.age),
        joinsHempPetition: form.joinsHempPetition === "yes",
        consentToUpdates: form.consentToUpdates === "yes",
        hempUse: form.hempUse === "Other" ? `Other: ${hempUseOther.trim()}` : form.hempUse,
      });
      setSuccessMessage(result.message || "Thank you. Your response has been received.");
    } catch (error) {
      if (error instanceof SurveySubmissionError) {
        setSubmitError(error.message);
        setFieldErrors(error.fields);
      } else {
        setSubmitError("Unable to submit the survey. Check your connection and try again.");
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  if (successMessage) {
    return (
      <main className="min-h-screen bg-[#eef2ef] px-4 py-8 text-[#18211d] sm:px-6 sm:py-12">
        <section className="mx-auto max-w-2xl overflow-hidden rounded-lg border border-[#cbd4cf] bg-white shadow-[0_18px_50px_rgba(24,33,29,0.12)]">
          <div className="h-2 bg-[#266c4d]" />
          <div className="px-6 py-12 text-center sm:px-12 sm:py-16">
            <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[#e4f3eb] text-[#1f7450]">
              <FiCheckCircle size={30} aria-hidden="true" />
            </span>
            <h1 className="mt-6 text-2xl font-bold text-[#17241e]">Response received</h1>
            <p className="mx-auto mt-3 max-w-md text-[15px] leading-6 text-[#58665f]">{successMessage}</p>
            <p className="mt-8 text-xs font-semibold uppercase tracking-[0.16em] text-[#7a8781]">Help Save the Hemp Industry</p>
            <img
              src={registerToVoteImage}
              alt="Vote"
              className="mx-auto mt-5 h-auto w-36 sm:w-40"
            />
            <a
              href="https://vrrequest.sos.texas.gov/VoterApplication/ConfirmStatusEN"
              target="_blank"
              rel="noreferrer"
              className="mx-auto mt-5 inline-flex min-h-14 w-full max-w-sm items-center justify-center gap-2 rounded-md bg-[#b91c1c] px-8 py-4 text-base font-bold text-white shadow-sm transition hover:bg-[#991b1b] focus:outline-none focus:ring-2 focus:ring-[#b91c1c] focus:ring-offset-2"
            >
              REGISTER TO VOTE
              <FiExternalLink size={17} aria-hidden="true" />
            </a>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#eef2ef] px-3 py-5 text-[#18211d] sm:px-6 sm:py-10">
      <section className="mx-auto max-w-3xl overflow-hidden rounded-lg border border-[#cbd4cf] bg-white shadow-[0_18px_50px_rgba(24,33,29,0.12)]">
        <header className="bg-[#152b22] px-5 py-6 text-[#ffffff] sm:px-9 sm:py-8">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#9dd3b7]">Texas community survey</p>
          <h1 className="mt-2 text-3xl font-bold leading-tight text-[#ffffff] sm:text-4xl">Help Save the Hemp Industry</h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-6 text-[rgba(255,255,255,0.76)]">
            Share your position on the proposed hemp ban and tell us how we may keep you informed.
          </p>
        </header>

        <form onSubmit={handleSubmit} noValidate>
          <div className="px-5 pb-2 pt-5 sm:px-9 sm:pt-7">
            <Question number="1" title="First Name" error={fieldErrors.firstName}>
              <input
                className={fieldClass}
                value={form.firstName}
                onChange={(event) => updateField("firstName", event.target.value)}
                autoComplete="given-name"
                maxLength={60}
                required
                aria-invalid={Boolean(fieldErrors.firstName)}
                placeholder="Enter your first name"
              />
            </Question>

            <Question number="2" title="Last Name" error={fieldErrors.lastName}>
              <input
                className={fieldClass}
                value={form.lastName}
                onChange={(event) => updateField("lastName", event.target.value)}
                autoComplete="family-name"
                maxLength={60}
                required
                aria-invalid={Boolean(fieldErrors.lastName)}
                placeholder="Enter your last name"
              />
            </Question>

            <Question number="3" title="Age" error={fieldErrors.age}>
              <input
                className={`${fieldClass} sm:max-w-[220px]`}
                type="number"
                inputMode="numeric"
                min={18}
                max={120}
                value={form.age}
                onChange={(event) => updateField("age", event.target.value)}
                required
                aria-invalid={Boolean(fieldErrors.age)}
                placeholder="Age"
              />
            </Question>

            <Question number="4" title="City of Residence" error={fieldErrors.city}>
              <input
                className={fieldClass}
                value={form.city}
                onChange={(event) => updateField("city", event.target.value)}
                autoComplete="address-level2"
                maxLength={100}
                required
                aria-invalid={Boolean(fieldErrors.city)}
                placeholder="City"
              />
            </Question>

            <Question number="5" title="County" error={fieldErrors.county}>
              <input
                className={fieldClass}
                value={form.county}
                onChange={(event) => updateField("county", event.target.value)}
                maxLength={100}
                required
                aria-invalid={Boolean(fieldErrors.county)}
                placeholder="County"
              />
            </Question>

            <Question number="6" title="Mobile Number" error={fieldErrors.mobileNumber}>
              <input
                className={fieldClass}
                type="tel"
                inputMode="tel"
                value={form.mobileNumber}
                onChange={(event) => updateField("mobileNumber", event.target.value)}
                autoComplete="tel"
                maxLength={24}
                required
                aria-invalid={Boolean(fieldErrors.mobileNumber)}
                placeholder="(555) 555-0123"
              />
            </Question>

            <Question number="7" title="Email Address" error={fieldErrors.email}>
              <input
                className={fieldClass}
                type="email"
                inputMode="email"
                value={form.email}
                onChange={(event) => updateField("email", event.target.value)}
                autoComplete="email"
                maxLength={254}
                required
                aria-invalid={Boolean(fieldErrors.email)}
                placeholder="name@example.com"
              />
            </Question>

            <Question number="8" title="Do you agree to join the hemp petition to prevent a ban in Texas?" error={fieldErrors.joinsHempPetition}>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <BinaryOption
                  name="joinsHempPetition"
                  value="yes"
                  checked={form.joinsHempPetition === "yes"}
                  onChange={() => updateField("joinsHempPetition", "yes")}
                  label="Yes"
                />
                <BinaryOption
                  name="joinsHempPetition"
                  value="no"
                  checked={form.joinsHempPetition === "no"}
                  onChange={() => updateField("joinsHempPetition", "no")}
                  label="No"
                />
              </div>
            </Question>

            <Question number="9" title="Do you opt in to receive updates about upcoming elections and hemp regulations?" error={fieldErrors.consentToUpdates}>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <BinaryOption
                  name="consentToUpdates"
                  value="yes"
                  checked={form.consentToUpdates === "yes"}
                  onChange={() => updateField("consentToUpdates", "yes")}
                  label="Yes"
                />
                <BinaryOption
                  name="consentToUpdates"
                  value="no"
                  checked={form.consentToUpdates === "no"}
                  onChange={() => updateField("consentToUpdates", "no")}
                  label="No"
                />
              </div>
            </Question>

            <Question number="10" title="What do you use hemp for?" required={false} error={fieldErrors.hempUse || fieldErrors.hempUseOther}>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {hempUseOptions.map((option) => (
                  <BinaryOption
                    key={option}
                    name="hempUse"
                    value={option}
                    checked={form.hempUse === option}
                    onChange={() => updateField("hempUse", option)}
                    label={option}
                  />
                ))}
              </div>
              {form.hempUse === "Other" && (
                <input
                  className={fieldClass}
                  value={form.hempUseOther}
                  onChange={(event) => updateField("hempUseOther", event.target.value)}
                  maxLength={440}
                  required
                  aria-invalid={Boolean(fieldErrors.hempUseOther)}
                  placeholder="Please specify"
                />
              )}
            </Question>

            <Question number="11" title="Name of Store Registered" required={false} error={fieldErrors.storeName}>
              <input
                className={fieldClass}
                value={form.storeName}
                onChange={(event) => updateField("storeName", event.target.value)}
                autoComplete="organization"
                maxLength={160}
                aria-invalid={Boolean(fieldErrors.storeName)}
                placeholder="Optional"
              />
            </Question>

            <div className="absolute -left-[10000px] top-auto h-px w-px overflow-hidden" aria-hidden="true">
              <label>
                Company website
                <input
                  tabIndex={-1}
                  autoComplete="off"
                  value={form.companyWebsite}
                  onChange={(event) => updateField("companyWebsite", event.target.value)}
                />
              </label>
            </div>
          </div>

          <footer className="border-t border-[#d9dfdc] bg-[#f8faf9] px-5 py-5 sm:flex sm:items-center sm:justify-between sm:gap-6 sm:px-9">
            <div aria-live="polite" className="min-h-5">
              {submitError ? (
                <p className="flex items-start gap-2 text-sm font-medium text-[#a5392f]">
                  <FiAlertCircle className="mt-0.5 shrink-0" aria-hidden="true" />
                  {submitError}
                </p>
              ) : (
                <p className="text-xs leading-5 text-[#69766f]">Your information will only be used according to your consent selection.</p>
              )}
            </div>
            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#266c4d] px-6 text-sm font-bold text-[#ffffff] transition hover:bg-[#1f5a40] focus:outline-none focus:ring-2 focus:ring-[#266c4d]/35 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 sm:mt-0 sm:w-auto"
            >
              {isSubmitting ? "Submitting..." : "Submit response"}
              {!isSubmitting && <FiArrowRight aria-hidden="true" />}
            </button>
          </footer>
        </form>
      </section>
    </main>
  );
}

function Question({
  number,
  title,
  required = true,
  error,
  children,
}: {
  number: string;
  title: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="min-w-0 border-b border-[#e1e6e3] py-5 first:pt-0 last:border-b-0 sm:py-6">
      <legend className="block w-full text-[15px] font-bold leading-6 text-[#202c26]">
        <span className="mr-2 text-[#266c4d]">{number}.</span>
        {title}
        {required && <span className="ml-1 text-[#a5392f]" aria-label="required">*</span>}
      </legend>
      {children}
      {error && <p className="mt-2 text-sm font-medium text-[#a5392f]">{error}</p>}
    </fieldset>
  );
}

function BinaryOption({ name, value, checked, onChange, label }: { name: string; value: string; checked: boolean; onChange: () => void; label: string }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-[#cbd4cf] px-3 py-3 text-sm leading-5 transition hover:border-[#7ea993] has-[:checked]:border-[#266c4d] has-[:checked]:bg-[#edf7f1]">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        required
        className="mt-0.5 h-4 w-4 shrink-0 accent-[#266c4d]"
      />
      <span>{label}</span>
    </label>
  );
}
