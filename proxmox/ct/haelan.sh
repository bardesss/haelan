#!/usr/bin/env bash
# Pinned so a run fetches the engine and the install script this release was written against.
# core has no tags, so its commit moves by hand. Exported because build.func only keeps a value
# that is already set and otherwise fetches every later file from main.
COMMUNITY_SCRIPTS_CORE_URL="${COMMUNITY_SCRIPTS_CORE_URL:-https://raw.githubusercontent.com/community-scripts/core/1bbf08250c009d8fae6491ea52196d5f9a465428}"
COMMUNITY_SCRIPTS_URL="${COMMUNITY_SCRIPTS_URL:-https://raw.githubusercontent.com/bardesss/haelan/v2.23.0/proxmox}" # x-release-please-version
export COMMUNITY_SCRIPTS_CORE_URL COMMUNITY_SCRIPTS_URL
_cs_boot="${COMMUNITY_SCRIPTS_CORE_DIR:-$(dirname "${BASH_SOURCE[0]}")/../../core}/core/build.func"
source "$_cs_boot" 2>/dev/null || source <(curl -fsSL "${COMMUNITY_SCRIPTS_CORE_URL}/core/build.func")
# Copyright (c) 2021-2026 community-scripts ORG
# Author: Bardesss
# License: MIT | https://github.com/community-scripts/ProxmoxVED/raw/main/LICENSE
# Source: https://github.com/bardesss/haelan

APP="Haelan"
var_tags="${var_tags:-health;dashboard;self-hosted}"
var_cpu="${var_cpu:-2}"
# The build is what sets this, not the running instance: vite bundles the web app inside the
# container. Idle afterwards is a couple of hundred megabytes.
var_ram="${var_ram:-4096}"
# About 120 MB of database per person-year, and the default seven daily backups are seven more
# copies of it, so the data alone reaches a couple of gigabytes before the node_modules tree.
var_disk="${var_disk:-12}"
var_os="${var_os:-debian}"
var_version="${var_version:-13}"
#var_arm64="${var_arm64:-no}" # unset = ask the user; set yes/no only when verified
var_unprivileged="${var_unprivileged:-1}"
# Their own issue tracker is where this would point if the script were in their repository. It is
# not, and will not be for months, so a container installed from here would be sending testers to
# a repository that does not carry the script it is asking them about.
var_testurl="${var_testurl:-https://github.com/bardesss/haelan/issues/232}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources

  if [[ ! -d /opt/haelan ]]; then
    msg_error "No ${APP} Installation Found!"
    exit
  fi

  if check_for_gh_release "haelan" "bardesss/haelan"; then
    # No create_backup: /opt/haelan holds nothing but code. The database, the encryption key and
    # the backups are in /opt/haelan_data, which this never touches. The new release builds in a
    # staging tree beside the running one, so a failed download or build leaves the service as it
    # was, and core's .pending marker makes the next run redo the update.
    rm -rf /opt/haelan.staging
    CLEAN_INSTALL=1 fetch_and_deploy_gh_release "haelan" "bardesss/haelan" "tarball" "latest" "/opt/haelan.staging"

    PNPM_VERSION=$(sed -n 's/.*"packageManager": "pnpm@\([^"+]*\).*/\1/p' /opt/haelan.staging/package.json)
    NODE_VERSION="24" NODE_MODULE="pnpm@${PNPM_VERSION:-11.22.0}" setup_nodejs

    msg_info "Building Haelan"
    cd /opt/haelan.staging
    $STD pnpm install --frozen-lockfile
    $STD pnpm build
    msg_ok "Built Haelan"

    # Containers installed before the service had its own user ran it as root.
    msg_info "Securing Data Directory"
    id -u haelan >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /opt/haelan_data --shell /usr/sbin/nologin haelan
    chown -R haelan:haelan /opt/haelan_data
    chmod 700 /opt/haelan_data
    sed -i 's/^User=root$/User=haelan\nGroup=haelan\nUMask=0077/' /etc/systemd/system/haelan.service
    systemctl daemon-reload
    msg_ok "Secured Data Directory"

    msg_info "Swapping In New Release"
    systemctl stop haelan
    rm -rf /opt/haelan.previous
    mv /opt/haelan /opt/haelan.previous
    mv /opt/haelan.staging /opt/haelan
    systemctl start haelan
    msg_ok "Swapped In New Release"

    # The route the image healthcheck uses: it answers only once the database has opened.
    msg_info "Waiting for Haelan"
    local healthy=0
    for _ in {1..30}; do
      if curl -fsS http://127.0.0.1:4235/api/setup/state >/dev/null 2>&1; then
        healthy=1
        break
      fi
      sleep 2
    done
    if [[ "$healthy" != "1" ]]; then
      systemctl stop haelan
      rm -rf /opt/haelan
      mv /opt/haelan.previous /opt/haelan
      systemctl start haelan
      msg_error "Haelan ${CHECK_UPDATE_RELEASE} did not answer, so the previous release is running again"
      exit 1
    fi
    rm -rf /opt/haelan.previous
    msg_ok "Updated successfully!"
  fi
  exit
}

start
build_container
description

msg_ok "Completed Successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW} Access it using the following URL:${CL}"
echo -e "${TAB}${GATEWAY}${BGN}http://${IP}:4235${CL}"
