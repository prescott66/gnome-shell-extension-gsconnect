'use strict';

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

const PluginsBase = imports.service.plugins.base;


var Metadata = {
    label: _('SFTP'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.SFTP',
    incomingCapabilities: ['kdeconnect.sftp'],
    outgoingCapabilities: ['kdeconnect.sftp.request'],
    actions: {
        mount: {
            label: _('Mount'),
            icon_name: 'folder-remote-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.sftp'],
            outgoing: ['kdeconnect.sftp.request']
        },
        unmount: {
            label: _('Unmount'),
            icon_name: 'media-eject-symbolic',

            parameter_type: null,
            incoming: ['kdeconnect.sftp'],
            outgoing: ['kdeconnect.sftp.request']
        }
    }
};


/**
 * SFTP Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/sftp
 * https://github.com/KDE/kdeconnect-android/tree/master/src/org/kde/kdeconnect/Plugins/SftpPlugin
 */
var Plugin = GObject.registerClass({
    Name: 'GSConnectSFTPPlugin'
}, class Plugin extends PluginsBase.Plugin {

    _init(device) {
        super._init(device, 'sftp');

        this._directories = {};
        this._mounted = false;
        this._mounting = false;
    }

    get has_sshfs() {
        return GLib.find_program_in_path(gsconnect.metadata.bin.sshfs);
    }

    handlePacket(packet) {
        // Ensure we don't mount on top of an existing mount
        if (this._mounted) return;

        if (packet.type === 'kdeconnect.sftp') {
            this._agnostic_mount(packet);
        }
    }

    connected() {
        super.connected();

        // Disable for all bluetooth connections
        if (this.device.connection_type === 'bluetooth') {
            this.device.lookup_action('mount').enabled = false;
            this.device.lookup_action('unmount').enabled = false;

        // Request a mount; if using sshfs we will "delay-connect"
        } else {
            this.mount();
        }
    }

    disconnected() {
        super.disconnected();
        this.unmount();
    }

    async _sftp_setup(packet) {
        try {
            // FIXME: normalize with _sshfs_setup()
            let ip = this.device.settings.get_string('tcp-host');
            let port = packet.body.port;

            this._user = packet.body.user;
            this._password = packet.body.password;
            this._file = Gio.File.new_for_uri('sftp://' + `${ip}:${port}` + '/');

            // If 'multiPaths' is present setup a GFile for each
            if (packet.body.hasOwnProperty('multiPaths')) {
                for (let i = 0; i < packet.body.multiPaths.length; i++) {
                    let name = packet.body.pathNames[i];
                    let path = packet.body.multiPaths[i];

                    this._directories[name] = this._file.get_uri() + path;
                }

            // If 'multiPaths' is missing use 'path' and assume a Camera folder
            } else {
                let uri = this._file.get_uri() + packet.body.path;
                this._directories[_('All files')] = uri;
                this._directories[_('Camera pictures')] = uri + 'DCIM/Camera';
            }

            return Promise.resolve(true);
        } catch (e) {
            return Promise.reject(e);
        }
    }

    async _sftp_mount() {
        try {
            let op = new Gio.MountOperation({
                username: this._user,
                password: this._password,
                password_save: Gio.PasswordSave.NEVER
            });

            // We already know the host, so just accept
            op.connect('ask-question', (op, message, choices) => {
                op.reply(Gio.MountOperationResult.HANDLED);
            });

            // We set the password, so just accept
            op.connect('ask-password', (op, message, user, domain, flags) => {
                op.reply(Gio.MountOperationResult.HANDLED);
            });

            // This is the actual call to mount the device
            await new Promise((resolve, reject) => {
                this._file.mount_enclosing_volume(0, op, null, (file, res) => {
                    try {
                        resolve(file.mount_enclosing_volume_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            // FIXME: get GMount from GVolumeMonitor
            let monitor = Gio.VolumeMonitor.get();

            for (let mount of monitor.get_mounts()) {
                if (this._file.get_uri() === mount.get_root().get_uri()) {
                    this._mount = mount;
                    break;
                }
            }

            if (!this._unmountId) {
                this._unmountId = this._mount.connect(
                    'unmounted',
                    this._sftp_remount.bind(this)
                );
            }

            return Promise.resolve(true);
        } catch (e) {
            return Promise.reject(e);
        }
    }

    // FIXME: check
    async _sftp_remount() {
        debug('GMount::unmounted');

        try {
            await this._sftp_mount();
        } catch (e) {
            this.unmount();
        }
    }

    async _sftp_unmount() {
        try {
            let op = new Gio.MountOperation({
                username: this._user,
                password: this._password,
                password_save: Gio.PasswordSave.NEVER,
                choice: 0
            });

            // We already know the host, so just accept
            op.connect('ask-question', (op, message, choices) => {
                op.reply(Gio.MountOperationResult.HANDLED);
            });

            // We set the password, so just accept
            op.connect('ask-password', (op, message, user, domain, flags) => {
                op.reply(Gio.MountOperationResult.HANDLED);
            });

            // This is the actual call to unmount the device
            return new Promise((resolve, reject) => {
                this._mount.unmount_with_operation(0, op, null, (mount, res) => {
                    try {
                        resolve(mount.unmount_with_operation_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
        } catch (e) {
            return Promise.reject(e);
        }
    }

    /**
     * Start the sshfs process and send the password
     */
    async _sshfs_mount() {
        try {
            let argv = [
                gsconnect.metadata.bin.sshfs,
                `${this._user}@${this._ip}:${this._remote_root}`,
                this._mountpoint,
                '-p', this._port.toString(),
                // 'disable multi-threaded operation'
                // Fixes file chunks being sent out of order and corrupted
                '-s',
                // 'foreground operation'
                '-f',
                // Do not use ~/.ssh/config
                '-F', '/dev/null',
                // Use the private key from the service certificate
                '-o', 'IdentityFile=' + gsconnect.configdir + '/private.pem',
                // Don't prompt for new host confirmation (we know the host)
                '-o', 'StrictHostKeyChecking=no',
                // Prevent storing as a known host
                '-o', 'UserKnownHostsFile=/dev/null',
                // Match keepalive for kdeconnect connection (30sx3)
                '-o', 'ServerAliveInterval=30',
                // Wait until mountpoint is first accessed to connect
                '-o', 'delay_connect',
                // Reconnect to server if connection is interrupted
                '-o', 'reconnect',
                // Set user/group permissions to allow readwrite access
                '-o', `uid=${this._uid}`, '-o', `gid=${this._gid}`,
                // 'read password from stdin (only for pam_mount!)'
                '-o', 'password_stdin'
            ];

            // Execute sshfs
            this._sshfs_proc = new Gio.Subprocess({
                argv: argv,
                flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            });
            this._sshfs_proc.init(null);

            // Cleanup when the process exits
            this._sshfs_proc.wait_async(null, this._sshfs_finish.bind(this));

            // Since we're using '-o reconnect' we watch stderr so we can quit
            // on errors *we* consider fatal, otherwise the process may dangle
            let stderr = new Gio.DataInputStream({
                base_stream: this._sshfs_proc.get_stderr_pipe()
            });
            this._sshfs_check(stderr);

            // Send session password
            return new Promise((resolve, reject) => {
                this._sshfs_proc.get_stdin_pipe().write_all_async(
                    `${this._password}\n`,
                    GLib.PRIORITY_DEFAULT,
                    null,
                    (stream, res) => {
                        try {
                            resolve(stream.write_all_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });
        } catch (e) {
            return Promise.reject(e);
        }
    }

    _sshfs_finish(proc, res) {
        try {
            proc.wait_finish(res);
        } catch (e) {
            // Silence errors
        } finally {
            this._sshfs_proc = undefined;

            // Make sure it's actually unmounted
            this._sshfs_unmount();

            // Reset the directories and 'mounted'
            this._mounted = false;
        }
    }

    async _sshfs_unmount() {
        try {
            let argv = ['umount', this._mountpoint];

            // On Linux `fusermount` should be available, but BSD uses `umount`
            // See: https://phabricator.kde.org/D6945
            if (GLib.find_program_in_path(gsconnect.metadata.bin.fusermount)) {
                argv = [gsconnect.metadata.bin.fusermount, '-uz', this._mountpoint];
            }

            let proc = new Gio.Subprocess({
                argv: argv,
                flags: Gio.SubprocessFlags.NONE
            });
            proc.init(null);

            await new Promise ((resolve, reject) => {
                proc.wait_async(null, (proc, res) => {
                    try {
                        resolve(proc.wait_finish(res));
                    } catch (e) {
                        // Silence errors
                        resolve(true);
                    }
                });
            });
        } catch (e) {
            return Promise.reject(e);
        }
    }

    /**
     * Ensure the mountpoint exists with the proper permissions and get the
     * UID and GID from the folder.
     *
     * TODO: If #607706 (https://bugzilla.gnome.org/show_bug.cgi?id=607706)
     *       is fixed in gvfs we can mount under $HOME and show in Nautilus
     */
    async _sshfs_setup(packet) {
        try {
            // Ensure mountpoint is ready for sshfs. Mountpoint will be at
            // /run/user/$UID/gsconnect/<device-id>
            this._mountpoint = GLib.build_filenamev([
                gsconnect.runtimedir,
                this.device.id
            ]);

            let dir = Gio.File.new_for_path(this._mountpoint);

            try {
                dir.make_directory_with_parents(null);
                dir.set_attribute_uint32('unix::mode', 448, 0, null);
            } catch (e) {
            }

            // Grab the uid/gid from the mountpoint
            let info = dir.query_info('unix::uid,unix::gid', 0, null);
            this._uid = info.get_attribute_uint32('unix::uid');
            this._gid = info.get_attribute_uint32('unix::gid');

            // FIXME: normalize with _sftp_setup();
            this._ip = this.device.settings.get_string('tcp-host');
            this._port = packet.body.port;
            this._remote_root = packet.body.path;
            this._user = packet.body.user;
            this._password = packet.body.password;

            // If 'multiPaths' is present find the common path prefix
            if (packet.body.hasOwnProperty('multiPaths')) {
                let prefix = [];
                let paths = packet.body.multiPaths.map(path => path.split('/'));

                // Find the common prefixes
                for (let dir of paths[0]) {
                    if (paths.every(path => path[0] === dir)) {
                        prefix.push(dir);
                        paths = paths.map(path => path.slice(1));
                    } else {
                        break;
                    }
                }

                // Rejoin the prefix and paths
                this._remote_root = GLib.build_filenamev(prefix);
                paths = paths.map(path => '/' + GLib.build_filenamev(path));

                // Set the directories
                for (let i = 0; i < paths.length; i++) {
                    let name = packet.body.pathNames[i];
                    let uri = 'file://' + this._mountpoint + paths[i];
                    this._directories[name] = uri;
                }

            // If 'multiPaths' is missing use 'path' and assume a Camera folder
            } else {
                let uri = 'file://' + this._mountpoint;
                this._directories[_('All files')] = 'file://' + this._mountpoint;
                this._directories[_('Camera pictures')] = uri + '/DCIM/Camera';
            }

            return Promise.resolve(true);
        } catch (e) {
            return Promise.reject(e);
        }
    }

    /**
     * Watch stderr output from the sshfs process for fatal errors
     */
    _sshfs_check(stream) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
            try {
                let msg = stream.read_line_finish_utf8(res)[0];

                if (msg !== null) {
                    if (msg.includes('ssh_dispatch_run_fatal')) {
                        let e = new Error(msg);
                        this.service.notify_error(e);
                        throw e;
                    }

                    logWarning(msg, `${this.device.name}: sshfs`);
                    this._sshfs_check(stream);
                }
            } catch (e) {
                debug(e);
                this.unmount();
            }
        });
    }

    /**
     * Replace the 'Mount' item with a submenu of directories
     */
    _addSubmenu() {
        // Sftp Submenu
        let submenu = new Gio.Menu();

        // Directories Section
        let directories = new Gio.Menu();

        for (let [name, uri] of Object.entries(this._directories)) {
            directories.append(name, `device.openPath::${uri}`);
        }

        submenu.append_section(null, directories);

        // Unmount Section/Item
        let unmount = new Gio.Menu();
        unmount.add_action(this.device.lookup_action('unmount'));
        submenu.append_section(null, unmount);

        // Files Item
        let item = new Gio.MenuItem();
        item.set_detailed_action('device.mount');

        // Icon with check emblem
        // TODO: better?
        let icon = new Gio.EmblemedIcon({
            gicon: new Gio.ThemedIcon({name: 'folder-remote-symbolic'})
        });
        let emblem = new Gio.Emblem({
            icon: new Gio.ThemedIcon({name: 'emblem-default'})
        });
        icon.add_emblem(emblem);
        item.set_icon(icon);

        item.set_attribute_value(
            'hidden-when',
            new GLib.Variant('s', 'action-disabled')
        );
        item.set_label(_('Files'));
        item.set_submenu(submenu);

        this.device.menu.replace_action('device.mount', item);
    }

    _removeSubmenu() {
        let index = this.device.menu.remove_action('device.mount');
        let action = this.device.lookup_action('mount');

        if (action !== null) {
            this.device.menu.add_action(action, index);
        }
    }

    /**
     * Send a request to mount the remote device
     */
    mount() {
        this.device.sendPacket({
            type: 'kdeconnect.sftp.request',
            body: {startBrowsing: true}
        });
    }

    /**
     * TODO: Transitional wrapper until Gio is thoroughly tested
     */
    async _agnostic_mount(packet) {
        try {
            // If mounting is already in progress, let that fail before retrying
            if (this._mounting) return;
            this._mounting = true;

            // Prefer sshfs
            if (this.has_sshfs) {
                await this._sshfs_setup(packet);
                await this._sshfs_mount();

            // Fallback to Gio
            } else {
                logWarning('sshfs not found: falling back to GMount');

                await this._sftp_setup(packet);
                await this._sftp_mount();
            }

            // Set 'mounted' and populate the menu
            this._mounted = true;
            this._mounting = false;
            this._addSubmenu();
        } catch (e) {
            logError(e, `${this.device.name}: ${this.name}`);
            this.unmount();
        }
    }

    /**
     * Remove the menu items, kill sshfs, replace the mount item
     */
    unmount() {
        try {
            // Bail if the filesystem is already unmounted
            if (!this._mounted) return;

            // TODO: Transitional wrapper until Gio is thoroughly tested
            if (this.has_sshfs) {
                this._sshfs_finish(null, null);

                // Be sure it's really unmounted
                if (this._mounted) this._sshfs_proc.force_exit();
            } else {
                this._mount.disconnect(this._unmountId);
                this._sftp_unmount();
            }

            // Reset the state and menu
            this._directories = {};
            this._mounted = false;
            this._mounting = false;
            this._removeSubmenu();
        } catch (e) {
            logError(e);
        }
    }

    destroy() {
        // FIXME: _sshfs_finish() may access plugin variables after finalization
        this.unmount();
        super.destroy();
    }
});

