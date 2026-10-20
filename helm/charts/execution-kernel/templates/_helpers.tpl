{{- define "execution-kernel.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "execution-kernel.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "execution-kernel.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "execution-kernel.labels" -}}
app.kubernetes.io/name: {{ include "execution-kernel.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "execution-kernel.selectorLabels" -}}
app.kubernetes.io/name: {{ include "execution-kernel.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "execution-kernel.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "execution-kernel.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
The namespace Kubernetes Jobs run in — defaults to the release namespace so
a plain `helm install` just works.
*/}}
{{- define "execution-kernel.databaseSecretName" -}}
{{- if .Values.existingSecret -}}
{{- .Values.existingSecret -}}
{{- else -}}
{{- include "execution-kernel.fullname" . -}}-db
{{- end -}}
{{- end -}}

{{- define "execution-kernel.databaseSecretKey" -}}
{{- if .Values.existingSecret -}}
{{- .Values.existingSecretKey -}}
{{- else -}}
database-url
{{- end -}}
{{- end -}}

{{/*
Built from postgres.auth.* when the bundled Postgres is enabled;
externalDatabaseUrl otherwise. Not used at all when existingSecret is set —
that Secret is referenced directly instead of one this chart creates.
*/}}
{{- define "execution-kernel.databaseUrl" -}}
{{- $root := .root -}}
{{- if $root.Values.postgres.enabled -}}
postgresql://{{ $root.Values.postgres.auth.username }}:{{ .password }}@{{ include "execution-kernel.fullname" $root }}-postgres:5432/{{ $root.Values.postgres.auth.database }}
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
{{- define "execution-kernel.postgresPassword" -}}
{{- if .Values.postgres.auth.password -}}
{{- .Values.postgres.auth.password -}}
{{- else -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "execution-kernel.databaseSecretName" .) -}}
{{- if and $existing (index ($existing.data | default dict) "postgres-password") -}}
{{- index $existing.data "postgres-password" | b64dec -}}
{{- else -}}
{{- randAlphaNum 32 -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
kernel-api's ServiceAccount: its own when the chart creates ServiceAccounts.
*/}}
{{- define "execution-kernel.apiServiceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- printf "%s-api" (include "execution-kernel.fullname" .) -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
An image reference from {repository, tag, digest}: by digest when one is set
(the tag kept for people reading it), so what runs can't change under a
moved tag. Usage: include "execution-kernel.image" .Values.image
*/}}
{{- define "execution-kernel.image" -}}
{{- if .digest -}}
{{ .repository }}:{{ .tag }}@{{ .digest }}
{{- else -}}
{{ .repository }}:{{ .tag }}
{{- end -}}
{{- end }}

{{/*
This chart's own image: values' image, its tag defaulting to the chart's
appVersion, so a released chart runs the image released with it.
Usage: include "execution-kernel.appImage" .
*/}}
{{- define "execution-kernel.appImage" -}}
{{- include "execution-kernel.image" (dict "repository" .Values.image.repository "tag" (.Values.image.tag | default .Chart.AppVersion) "digest" .Values.image.digest) -}}
{{- end }}
