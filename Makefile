
all: test/calculator.ts
	npm test

.PHONY: clean
clean:
	rm -f test/calculator.ts

.PHONY: distclean
	$(MAKE) test/calculator.ts
	rm -rf lib/
	rm -rf test/lib/

test/calculator.ts: examples/calculator.ts
	tsastgen examples/calculator.ts:test/calculator.ts --with-root-node CalcNode --with-parent-member parentNode

