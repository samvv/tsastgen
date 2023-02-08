
all: test/calculator.ts
	npm test

.PHONY: clean
clean:
	rm -f test/calculator.ts

.PHONY: distclean
	$(MAKE) test/calculator.ts
	rm -rf lib/
	rm -rf test/lib/

test/calculator.ts: $(wildcard src/*.ts) examples/calculator.ts
	tsastgen examples/calculator.ts:test/calculator.ts --root-node CalcNode --with-parent-member parentNode
	tsastgen examples/calculator.ts:test/calculator-with-mutators.ts --root-node CalcNode --with-parent-member parentNode --with-mutators
