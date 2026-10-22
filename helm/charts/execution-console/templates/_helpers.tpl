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
postgresql://{{ $root.Values.postgres.auth.username }}:{{ .password }}@{{ include "execution-console.fullname" $root }}-postgres:5432/{{ $root.Values.postgres.auth.database }}
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
