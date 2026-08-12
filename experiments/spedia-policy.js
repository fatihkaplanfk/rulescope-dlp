import { loadAndValidatePolicy } from "../src/schema.js";

const basePolicy = {
  name: "SPEDIA metadata-derived DLP control policy",
  version: "1.0",
  semantics: "first_match",
  default_action: "Permit",
  domains: {
    user_group: ["General", "Finance", "HR", "Engineering", "Executive", "Security"],
    data_classification: ["Public", "Internal", "Confidential", "Restricted"],
    content_type: [
      "Attachment", "Message", "CloudService", "WebRequest", "SensitiveFile",
      "FileOperation", "DeviceConnect", "DeviceDisconnect"
    ],
    channel: ["Email", "Web", "CloudUpload", "USB", "EndpointApp"],
    destination_trust: ["Trusted", "Partner", "Untrusted"],
    device_trust: ["Managed", "Unmanaged"],
    file_type: ["PDF", "DOCX", "XLSX", "CSV", "ZIP", "TXT", "OTHER"]
  },
  numeric_limits: { size_mb: [0, 10240] },
  rules: [
    {
      id: "R_EMAIL_EXTERNAL_ATTACHMENT",
      priority: 10,
      description: "Block attachments sent to external email recipients.",
      conditions: {
        data_classification: "Restricted",
        content_type: "Attachment",
        channel: "Email",
        destination_trust: "Untrusted"
      },
      action: "Block"
    },
    {
      id: "R_CLOUD_TRANSFER",
      priority: 20,
      description: "Block access classified as an untrusted cloud-transfer event.",
      conditions: {
        data_classification: "Confidential",
        content_type: "CloudService",
        channel: "CloudUpload",
        destination_trust: "Untrusted"
      },
      action: "Block"
    },
    {
      id: "R_USB_CONNECT",
      priority: 30,
      description: "Block unmanaged removable-device connection events.",
      conditions: {
        data_classification: "Internal",
        content_type: "DeviceConnect",
        channel: "USB",
        destination_trust: "Untrusted",
        device_trust: "Unmanaged"
      },
      action: "Block"
    },
    {
      id: "R_SENSITIVE_ENDPOINT_FILE",
      priority: 40,
      description: "Audit accesses to metadata-derived sensitive endpoint paths.",
      conditions: {
        data_classification: "Confidential",
        content_type: "SensitiveFile",
        channel: "EndpointApp"
      },
      action: "Audit"
    }
  ],
  requirements: [
    {
      id: "REQ_EMAIL_EXTERNAL_ATTACHMENT",
      description: "External email attachments must be blocked.",
      conditions: {
        data_classification: "Restricted",
        content_type: "Attachment",
        channel: "Email",
        destination_trust: "Untrusted"
      },
      minimum_action: "Block"
    },
    {
      id: "REQ_CLOUD_TRANSFER",
      description: "Untrusted cloud-transfer events must be blocked.",
      conditions: {
        data_classification: "Confidential",
        content_type: "CloudService",
        channel: "CloudUpload",
        destination_trust: "Untrusted"
      },
      minimum_action: "Block"
    },
    {
      id: "REQ_USB_CONNECT",
      description: "Unmanaged removable-device connections must be blocked.",
      conditions: {
        data_classification: "Internal",
        content_type: "DeviceConnect",
        channel: "USB",
        destination_trust: "Untrusted",
        device_trust: "Unmanaged"
      },
      minimum_action: "Block"
    }
  ]
};

const emailShadow = {
  id: "M_EMAIL_EARLY_PERMIT",
  priority: 1,
  description: "Injected fault: an early permit shadows external-attachment blocking.",
  conditions: {
    data_classification: "Restricted",
    content_type: "Attachment",
    channel: "Email",
    destination_trust: "Untrusted"
  },
  action: "Permit"
};

const cloudConflict = {
  id: "M_CLOUD_ZERO_SIZE_AUDIT",
  priority: 15,
  description: "Injected fault: zero-size cloud events are audited before the block rule.",
  conditions: {
    data_classification: "Confidential",
    content_type: "CloudService",
    channel: "CloudUpload",
    destination_trust: "Untrusted",
    size_mb: 0
  },
  action: "Audit"
};

export function buildSpediaPolicies() {
  return [
    variant("clean", []),
    variant("shadow_email", ["shadow_email"]),
    variant("exception_usb", ["exception_usb"]),
    variant("conflict_cloud", ["conflict_cloud"]),
    variant("combined_faults", ["shadow_email", "exception_usb", "conflict_cloud"])
  ];
}

function variant(id, mutations) {
  const raw = structuredClone(basePolicy);
  raw.name = `${basePolicy.name} [${id}]`;
  if (mutations.includes("shadow_email")) raw.rules.push(structuredClone(emailShadow));
  if (mutations.includes("conflict_cloud")) raw.rules.push(structuredClone(cloudConflict));
  if (mutations.includes("exception_usb")) {
    const usb = raw.rules.find(rule => rule.id === "R_USB_CONNECT");
    usb.exceptions = [{ user_group: "General" }];
  }
  return { id, mutations, policy: loadAndValidatePolicy(raw) };
}

