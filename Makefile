PACKAGE := yt-unsub-detector
VERSION := $(shell dpkg-parsechangelog -S Version)
DEB := $(PACKAGE)_$(VERSION)_all.deb
SUITE ?= stonking

.PHONY: test package source-package apt-repository clean
test:
	node --check background.js
	node --check shared.js
	node --check drive.js
	node --check content/content.js
	node --check content/main-world.js
	node --check popup/popup.js
	node --test tests/*.test.cjs
	python3 -m unittest discover -s tests -p 'test_*.py' -v
	sh -n packaging/yt-unsub-detector scripts/*.sh debian/postinst debian/postrm

package:
	mkdir -p dist
	dpkg-buildpackage -us -uc -b
	cp "../$(DEB)" "dist/$(DEB)"
	cd dist && sha256sum "$(DEB)" > SHA256SUMS

source-package:
	mkdir -p dist
	dpkg-buildpackage -us -uc -S
	cp "../$(PACKAGE)_$(VERSION).dsc" "../$(PACKAGE)_$(VERSION).tar.xz" dist/

apt-repository:
	@test -f "dist/$(DEB)" || { echo 'Run make package first.' >&2; exit 1; }
	rm -rf dist/debs dist/apt
	mkdir -p dist/debs
	cp "dist/$(DEB)" dist/debs/
	bash scripts/build-apt-repository.sh dist/debs dist/apt "$(SUITE)"
	@echo 'Unsigned metadata created in dist/apt. Run scripts/sign-apt-repository.sh before publishing.'

clean:
	rm -rf dist debian/$(PACKAGE)
	rm -f debian/files debian/*.substvars
