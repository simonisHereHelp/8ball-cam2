import path from "path";

const JSON_CANON_BASE_PATH =
  process.env.JSON_CANON_BASE_PATH ||
  path.resolve(process.cwd(), "..", "..", "json_canon");

const buildLocalPath = (fileName: string) => path.join(JSON_CANON_BASE_PATH, fileName);

const resolveJsonSource = (
  envPath: string | undefined,
  envId: string | undefined,
  localFileName: string,
) => {
  if (envPath) return envPath;
  if (envId) return envId;
  return buildLocalPath(localFileName);
};

export const PROMPT_SUMMARY_SOURCE = resolveJsonSource(
  process.env.PROMPT_SUMMARY_JSON_PATH,
  process.env.PROMPT_SUMMARY_JSON_ID,
  "prompt_summary.json",
);

export const PROMPT_EXTRACT_SOURCE = resolveJsonSource(
  process.env.PROMPT_EXTRACT_JSON_PATH,
  process.env.PROMPT_EXTRACT_JSON_ID,
  "prompt_extract.json",
);

export const ONE_SHOT_EXAMPLE_SOURCE = resolveJsonSource(
  process.env.ONE_SHOT_EXAMPLE_JSON_PATH,
  process.env.ONE_SHOT_EXAMPLE_JSON_ID,
  "one_shot_example.json",
);

export const SUBJECT_CAT_DOC_CLASS_ACTION_VERB_SOURCE = resolveJsonSource(
  process.env.SUBJECT_CAT_DOC_CLASS_ACTION_VERB_JSON_PATH,
  process.env.SUBJECT_CAT_DOC_CLASS_ACTION_VERB_JSON_ID,
  "subjectCat_docClass_actionVerb.json",
);

export const PROMPT_SET_NAME_SOURCE = resolveJsonSource(
  process.env.PROMPT_SET_NAME_JSON_PATH,
  process.env.PROMPT_SET_NAME_JSON_ID,
  "prompts_setName.json",
);

export const PROMPT_DESIGNATED_SUBFOLDER_SOURCE = resolveJsonSource(
  process.env.PROMPT_DESIGNATED_SUBFOLDER,
  process.env.PROMPT_DESIGNATED_SUBFOLDER_ID,
  "prompt_designated_subfolder.json",
);

export const DRIVE_ACTIVE_SUBFOLDER_SOURCE = resolveJsonSource(
  process.env.DRIVE_ACTIVE_SUBFOLDER_PATH,
  process.env.DRIVE_ACTIVE_SUBFOLDER_ID,
  "drive_active_subfolder_list.json",
);

export const DRIVE_FALLBACK_FOLDER_ID =
  process.env.DRIVE_FALLBACK_FOLDER_ID || process.env.DRIVE_FOLDER_ID;

export const DRIVE_DOCS_TRAINING_FOLDER_ID =
  process.env.DRIVE_FOLDER_ID_DOCS_TRAINING || "";
