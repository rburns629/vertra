# SPDX-License-Identifier: MIT
"""The sleeper: puts an idle platform to sleep (scales its Deployments to
zero), so a quiet install costs only its database's volume. Waking is
explicit (``acyclixctl wake``): a sleeping console can't wake itself."""
