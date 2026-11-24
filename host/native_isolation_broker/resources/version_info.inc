// Shared VERSIONINFO for the binaries that get file properties. The including .rc file defines
// SC_FILE_DESCRIPTION and SC_ORIGINAL_FILENAME; build.rs defines SC_VERSION_* from
// SUPERCLAW_BUILD_VERSION, or from the crate version when that is unset.
//
// This is an .inc, not a .h: rc.exe silently drops resource statements from an included .h file.
// The winver.h constants are spelled out below rather than included: rc.exe finds system headers only
// through the INCLUDE variable, which a Developer Command Prompt sets and a plain shell does not.

1 VERSIONINFO
FILEVERSION SC_VERSION_MAJOR, SC_VERSION_MINOR, SC_VERSION_PATCH, SC_VERSION_BUILD
PRODUCTVERSION SC_VERSION_MAJOR, SC_VERSION_MINOR, SC_VERSION_PATCH, SC_VERSION_BUILD
FILEOS 0x40004L // VOS_NT_WINDOWS32
FILETYPE 1 // VFT_APP
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904B0"
    BEGIN
      // Same company as SuperClaw.aip Manufacturer and tauri.conf.json publisher.
      VALUE "CompanyName", "Intel"
      VALUE "ProductName", "SuperClaw"
      VALUE "FileDescription", SC_FILE_DESCRIPTION
      VALUE "OriginalFilename", SC_ORIGINAL_FILENAME
      VALUE "FileVersion", SC_VERSION_STRING
      VALUE "ProductVersion", SC_VERSION_STRING
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x0409, 1200
  END
END
