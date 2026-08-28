.PHONY: build serve clean

build:
	python3 site_src/build.py

serve: build
	cd public && python3 -m http.server 8080

clean:
	rm -rf public
