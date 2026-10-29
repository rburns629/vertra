{{- define "execution-console.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "execution-console.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "execution-console.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "execution-console.labels" -}}
app.kubernetes.io/name: {{ include "execution-console.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "execution-console.selectorLabels" -}}
app.kubernetes.io/name: {{ include "execution-console.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "execution-console.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "execution-console.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
This chart's own Secret (jwt-secret always lives here; database-url does
too unless existingSecret is set) -- distinct from databaseSecretName
below, which is *which* secret DATABASE_URL is actually read from.
*/}}
{{- define "execution-console.secretName" -}}
{{- include "execution-console.fullname" . -}}
{{- end -}}

{{- define "execution-console.databaseSecretName" -}}
{{- if .Values.existingSecret -}}
{{- .Values.existingSecret -}}
{{- else -}}
{{- include "execution-console.secretName" . -}}
{{- end -}}
{{- end -}}

{{- define "execution-console.databaseSecretKey" -}}
{{- if .Values.existingSecret -}}
{{- .Values.existingSecretKey -}}
{{- else -}}
database-url
{{- end -}}
{{- end -}}

{{/*
Built from postgres.auth.* when the bundled Postgres is enabled;
externalDatabaseUrl otherwise. Not used at all when existingSecret is set.
A plain "postgresql://" URL, as execution-kernel's.
*/}}
{{- define "execution-console.databaseUrl" -}}
{{- $root := .root -}}
{{- if $root.Values.postgres.enabled -}}
postgresql://{{ $root.Values.postgres.auth.username }}:{{ .password }}@{{ include "execution-console.fullname" $root }}-postgres:5432/{{ $root.Values.postgres.auth.database }}{{ include "execution-console.databaseTls" $root }}
{{- else -}}
{{- $root.Values.externalDatabaseUrl -}}
{{- end -}}
{{- end -}}

{{/*
The bundled Postgres's password: postgres.auth.password if set; otherwise
the one already in this release's Secret, so upgrades keep it; otherwise a
new random one. Random each time it's called on a fresh install: call it
once per render and reuse the value (secret.yaml does).
*/}}
{{- define "execution-console.postgresPassword" -}}
{{- if .Values.postgres.auth.password -}}
{{- .Values.postgres.auth.password -}}
{{- else -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "execution-console.secretName" .) -}}
{{- if and $existing (index ($existing.data | default dict) "postgres-password") -}}
{{- index $existing.data "postgres-password" | b64dec -}}
{{- else -}}
{{- randAlphaNum 32 -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
An image reference from {repository, tag, digest}: by digest when one is set
(the tag kept for people reading it), so what runs can't change under a
moved tag. Usage: include "execution-console.image" .Values.image
*/}}
{{- define "execution-console.image" -}}
{{- if .digest -}}
{{ .repository }}:{{ .tag }}@{{ .digest }}
{{- else -}}
{{ .repository }}:{{ .tag }}
{{- end -}}
{{- end }}

{{/*
This chart's own image: values' image, its tag defaulting to the chart's
appVersion, so a released chart runs the image released with it.
Usage: include "execution-console.appImage" .
*/}}
{{- define "execution-console.appImage" -}}
{{- include "execution-console.image" (dict "repository" .Values.image.repository "tag" (.Values.image.tag | default .Chart.AppVersion) "digest" .Values.image.digest) -}}
{{- end }}

{{/*
Single sign-on's client secret, for every Pod that reads the console's
settings (the console, and its migrations: the settings are checked whole at
startup, and the ConfigMap names the provider).
Usage: include "execution-console.ssoEnv" .
*/}}
{{- define "execution-console.ssoEnv" -}}
{{- if .Values.sso.issuer }}
- name: OIDC_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .Values.sso.clientSecret.name }}
      key: {{ .Values.sso.clientSecret.key }}
{{- end }}
{{- end }}

{{/*
Pod Security's restricted, for this chart's own Pods: required, so a change
to an image can't quietly start running as root. The image picks its
(numeric, non-root) user; the root filesystem is read-only, /tmp an emptyDir.
Usage: include "execution-console.podSecurityContext" . (and containerSecurityContext)
*/}}
{{- define "execution-console.podSecurityContext" -}}
runAsNonRoot: true
seccompProfile: {type: RuntimeDefault}
{{- end }}

{{- define "execution-console.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities: {drop: ["ALL"]}
{{- end }}

{{/*
The gateway's Pods: its Deployment selects them by these, and each team
namespace's vertra-gateway-ingress lets them reach the team's API backends.
*/}}
{{- define "execution-console.gatewaySelectorLabels" -}}
{{ include "execution-console.selectorLabels" . }}
app.kubernetes.io/component: gateway
{{- end -}}

{{/*
The gateway's database credentials: gateway.database.existingSecret's
database-url, or, with this chart's own Postgres, keys in its own Secret.
*/}}
{{- define "execution-console.gatewayDatabaseSecretName" -}}
{{- if .Values.gateway.database.existingSecret -}}
{{- .Values.gateway.database.existingSecret -}}
{{- else if .Values.postgres.enabled -}}
{{- include "execution-console.secretName" . -}}
{{- else -}}
{{- fail "gateway.enabled needs gateway.database.existingSecret (the kernel chart's <release>-execution-kernel-gateway-db, or one of yours), unless postgres.enabled" -}}
{{- end -}}
{{- end -}}

{{- define "execution-console.gatewayDatabaseSecretKey" -}}
{{- if .Values.gateway.database.existingSecret -}}database-url{{- else -}}gateway-database-url{{- end -}}
{{- end -}}

{{/*
TLS inside the cluster. databaseTls ends a URL for this chart's own Postgres
(tls.yaml): TLS required, checked against its CA at /etc/vertra/tls-db.
tlsVolumes/tlsMounts give a Pod that CA and the kernel chart's
(tls.kernelCaSecret: kernel-api's, and the kernel's Postgres's when the
console's database is there) at /etc/vertra/tls; tlsEnv makes Node trust
the kernel's for kernel-api.
*/}}
{{- define "execution-console.databaseTls" -}}
{{- if and .Values.tls.enabled .Values.postgres.enabled -}}
?sslmode=verify-full&sslrootcert=/etc/vertra/tls-db/ca.crt
{{- end -}}
{{- end -}}

{{- define "execution-console.tlsVolumes" -}}
{{- if .Values.tls.kernelCaSecret }}
- name: kernel-ca
  secret:
    secretName: {{ .Values.tls.kernelCaSecret }}
    # Made by the kernel chart's upgrade that turns tls on: a console
    # upgraded first still migrates, connecting as before until then.
    optional: true
{{- end }}
{{- if and .Values.tls.enabled .Values.postgres.enabled }}
- name: db-ca
  secret:
    secretName: {{ include "execution-console.fullname" . }}-tls-ca
    # The upgrade that turns tls on runs its migration before the Secret
    # exists; it still connects as before then, without TLS.
    optional: true
{{- end }}
{{- end -}}

{{- define "execution-console.tlsMounts" -}}
{{- if .Values.tls.kernelCaSecret }}
- {name: kernel-ca, mountPath: /etc/vertra/tls, readOnly: true}
{{- end }}
{{- if and .Values.tls.enabled .Values.postgres.enabled }}
- {name: db-ca, mountPath: /etc/vertra/tls-db, readOnly: true}
{{- end }}
{{- end -}}

{{- define "execution-console.tlsEnv" -}}
{{- if .Values.tls.kernelCaSecret }}
- {name: NODE_EXTRA_CA_CERTS, value: /etc/vertra/tls/ca.crt}
{{- end }}
{{- end -}}

{{/* This chart's own Postgres's pg_hba with tls: the Pod's own tools over
its socket as before; from the network, TLS and a password only. */}}
{{- define "execution-console.pgHba" -}}
local   all  all            trust
hostssl all  all  0.0.0.0/0 scram-sha-256
hostssl all  all  ::/0      scram-sha-256
{{- end -}}
