export type CreateSkillFormValues = {
  name: string;
  yaml: string;
  body: string;
};

/**
 * Whether a successful create may reset the form to its preset text.
 *
 * The inputs stay editable while the save is in flight, so the form is reset
 * only when it still holds what was submitted; otherwise the reset would
 * discard whatever the user typed during the save.
 */
export function shouldResetCreateSkillForm(
  current: CreateSkillFormValues,
  submitted: CreateSkillFormValues,
): boolean {
  return (
    current.name.trim() === submitted.name.trim() &&
    current.yaml.trim() === submitted.yaml.trim() &&
    current.body === submitted.body
  );
}
