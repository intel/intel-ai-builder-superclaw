import { Show } from "solid-js";

import ConfirmModal from "../confirm-modal";
import { t } from "../../../i18n";
import type { ComposerFolderUpload } from "./composer.folder-upload";
import type { PendingFolderUpload } from "./composer.types";

const MB = 1024 * 1024;
const LARGE_FOLDER_FILES = 500;
const LARGE_FOLDER_BYTES = 100 * MB;

/** Everything the modal says about the folder waiting to be confirmed. */
function PendingFolderDetails(props: {
  upload: ComposerFolderUpload;
  pending: PendingFolderUpload;
}) {
  const scan = () => props.pending.scan;
  const isLarge = () =>
    !scan().truncated &&
    (scan().entries.length > LARGE_FOLDER_FILES ||
      scan().totalBytes > LARGE_FOLDER_BYTES);

  return (
    <>
      <p>
        {t("composer.upload_folder_confirm_prefix")} {scan().entries.length}{" "}
        {t("composer.upload_folder_confirm_files_from")} "
        {props.pending.folderName}"{" "}
        {t("composer.upload_folder_confirm_to_workspace")}
      </p>
      <p class="mt-1 text-caption text-dls-secondary">
        {t("composer.folder_total_size")}: {(scan().totalBytes / MB).toFixed(1)}{" "}
        MB
      </p>
      <Show when={scan().skippedDirs.length}>
        <p class="mt-1 text-caption text-dls-secondary">
          {t("composer.folder_skipped_note")}: {scan().skippedDirs.join(", ")}
        </p>
      </Show>
      <Show when={scan().truncated}>
        <p class="mt-1 text-caption text-dls-warning-text">
          {t("composer.folder_truncated_warning")}
        </p>
      </Show>
      <Show when={isLarge()}>
        <p class="mt-1 text-caption text-dls-warning-text">
          {t("composer.folder_large_warning")}
        </p>
      </Show>
      <Show
        when={props.upload.progress()}
        fallback={<p class="mt-2">{t("composer.please_confirm")}</p>}
      >
        {(progress) => (
          <div class="mt-3">
            <div class="h-1 w-full overflow-hidden rounded-pill bg-dls-active/50">
              <div
                class="h-full rounded-pill bg-dls-info/60 transition-[width] duration-300 ease-out"
                style={{
                  width: `${Math.round((progress().done / Math.max(1, progress().total)) * 100)}%`,
                }}
              />
            </div>
            <p class="mt-1 text-caption font-mono text-dls-secondary">
              {progress().done} / {progress().total}
            </p>
          </div>
        )}
      </Show>
    </>
  );
}

/** Confirmation and progress for a folder upload into the workspace inbox. */
export default function FolderUploadConfirmModal(props: {
  upload: ComposerFolderUpload;
}) {
  return (
    <ConfirmModal
      open={Boolean(props.upload.pending())}
      title={t("composer.upload_folder_confirm_title")}
      message={
        <Show
          when={props.upload.pending()}
          fallback={
            <>
              <p>{t("composer.upload_this_folder_to_workspace")}</p>
              <p class="mt-2">{t("composer.please_confirm")}</p>
            </>
          }
        >
          {(pending) => (
            <PendingFolderDetails upload={props.upload} pending={pending()} />
          )}
        </Show>
      }
      confirmLabel={
        props.upload.busy() ? t("composer.uploading") : t("composer.upload")
      }
      cancelLabel={
        props.upload.cancelling()
          ? t("composer.folder_cancelling")
          : t("common.cancel")
      }
      onConfirm={props.upload.confirm}
      onCancel={props.upload.cancel}
    />
  );
}
