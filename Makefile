UUID := lofi-bar@obk.github.io
SOURCES := extension.js player.js playerProcess.js net.js radioBrowser.js stations.js
INSTALL_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all pack install uninstall clean

all: pack

# Builds the zip that extensions.gnome.org and `gnome-extensions install` accept.
pack: $(UUID).shell-extension.zip

$(UUID).shell-extension.zip: metadata.json stylesheet.css $(SOURCES) icons/lofi-bar-symbolic.svg schemas/*.gschema.xml
	gnome-extensions pack --force \
		$(foreach f,$(filter-out extension.js,$(SOURCES)),--extra-source=$(f)) \
		--extra-source=icons \
		--schema=schemas/org.gnome.shell.extensions.lofi-bar.gschema.xml \
		.

install: pack
	gnome-extensions install --force $(UUID).shell-extension.zip
	glib-compile-schemas $(INSTALL_DIR)/schemas
	@echo
	@echo "Installed. On Wayland, log out and back in once, then run:"
	@echo "  gnome-extensions enable $(UUID)"

uninstall:
	gnome-extensions uninstall $(UUID)

clean:
	rm -f $(UUID).shell-extension.zip schemas/gschemas.compiled
