#!/usr/bin/env bash
# Pinned so a run fetches the engine and the install script this release was written against.
# core has no tags, so its commit moves by hand. Exported because build.func only keeps a value
# that is already set and otherwise fetches every later file from main.
COMMUNITY_SCRIPTS_CORE_URL="${COMMUNITY_SCRIPTS_CORE_URL:-https://raw.githubusercontent.com/community-scripts/core/1bbf08250c009d8fae6491ea52196d5f9a465428}"
COMMUNITY_SCRIPTS_URL="${COMMUNITY_SCRIPTS_URL:-https://raw.githubusercontent.com/bardesss/haelan/v2.24.1/proxmox}" # x-release-please-version
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

    msg_info "Stopping Haelan"
    systemctl stop haelan
    msg_ok "Stopped Haelan"

    # Containers installed before the service had its own user ran it as root. Done with the
    # service stopped, so a root process cannot write a file into the data directory after the
    # chown that the haelan user could then not open.
    msg_info "Securing Data Directory"
    id -u haelan >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /opt/haelan_data --shell /usr/sbin/nologin haelan
    install -d -m 700 -o haelan -g haelan /opt/haelan_data
    chown -R haelan:haelan /opt/haelan_data
    chmod 700 /opt/haelan_data
    sed -i 's/^User=root$/User=haelan\nGroup=haelan\nUMask=0077/' /etc/systemd/system/haelan.service
    systemctl daemon-reload
    msg_ok "Secured Data Directory"

    msg_info "Swapping In New Release"
    rm -rf /opt/haelan.previous
    mv /opt/haelan /opt/haelan.previous
    mv /opt/haelan.staging /opt/haelan
    systemctl start haelan
    msg_ok "Swapped In New Release"

    # The image healthcheck's probe, run with the unit's environment so a drop-in that moves the
    # port or host is honoured. The route answers only once the database has opened, which is
    # after the server has applied any migrations, so a long migration can take minutes. Rolling
    # back after one committed would start the old release on a database it no longer reads, so
    # this waits for as long as the unit stays up and rolls back only when it failed or restarted.
    msg_info "Waiting for Haelan"
    local probe_env=() healthy=0 crashed=0
    read -r -a probe_env <<<"$(systemctl show haelan -p Environment --value)"
    for _ in {1..300}; do
      if env "${probe_env[@]}" /usr/bin/node /opt/haelan/apps/server/src/healthcheck.ts; then
        healthy=1
        break
      fi
      if systemctl is-failed --quiet haelan ||
        [[ "$(systemctl show haelan -p NRestarts --value)" != "0" ]] ||
        ! systemctl is-active --quiet haelan; then
        crashed=1
        break
      fi
      sleep 2
    done
    if [[ "$crashed" == "1" ]]; then
      systemctl stop haelan
      rm -rf /opt/haelan
      mv /opt/haelan.previous /opt/haelan
      systemctl start haelan
      msg_error "Haelan ${CHECK_UPDATE_RELEASE:-the new release} failed to start, so the previous release is running again"
      exit 1
    fi
    if [[ "$healthy" != "1" ]]; then
      msg_error "Haelan ${CHECK_UPDATE_RELEASE:-the new release} is running but has not answered in 10 minutes, so it was left in place in case it is still migrating the database. To go back to the previous release: systemctl stop haelan && rm -rf /opt/haelan && mv /opt/haelan.previous /opt/haelan && systemctl start haelan"
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
