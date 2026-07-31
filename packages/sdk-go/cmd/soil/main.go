// The soil CLI, as one static binary.
//
// Two halves of one round trip:
//
//	soil save              prints the recipe you paste into your model
//	soil save -            reads the model's JSON back and stores it
//	soil load #004         prints the restore prompt you paste anywhere else
//
// Everything runs against ~/.soil. No account, no network, no telemetry. The
// command surface is deliberately small: a tool you use at the exact moment a
// thread is dying should have nothing to learn.
//
// The command surface, the output bytes and the exit codes match the Node
// CLI in packages/cli, so the two are interchangeable in scripts. Run takes
// its whole environment as an argument so tests drive the real command paths
// without spawning a process or touching a real home directory.

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"

	handover "github.com/nativesoil/handover/packages/sdk-go"
)

// Environment is everything the CLI touches that is not an argument.
type Environment struct {
	Stdout   io.Writer
	Stderr   io.Writer
	Stdin    io.Reader
	ReadFile func(path string) ([]byte, error)
	Getenv   func(name string) string
	Now      func() time.Time
}

const help = `soil — save the project state, load it anywhere, see what survived.

USAGE
  soil save                     print the extraction recipe to paste into your model
  soil save -                   read the model's JSON reply on stdin and store it
  soil save <file.json>         store a handover from a file
  soil load [#NNN|last]         print the restore prompt for a stored handover
  soil list                     list what is stored
  soil validate <file|->        check a document against the spec
  soil check <#NNN|file|->      check and grade a handover with deterministic rules
  soil render <#NNN|file>       print the rail card for a handover
  soil rescue                   print the prompt for a dead or full thread
  soil where                    print the store location

OPTIONS
  --json                        with load/render/check: print the raw document or report
  --quiet                       with save: print only the load code
  --attach                      with check on a stored code: write the report onto the
                                handover as a quality.capture observation
  -h, --help                    this text
  -v, --version                 print the version

The store is ~/.soil, or $SOIL_HOME when that is set. Nothing leaves the machine.
Saving records what your model wrote and counts the sections that carry content.
` + "`soil check`" + ` grades the document with open deterministic rules (docs/checking.md);
whether a handover actually restores a session is answered only by a real load.
`

// cliVersion is what producedBy records on an attached report, matching the
// Node CLI's soil-cli/<version>.
const cliVersion = "0.1.0"

const version = cliVersion + " (spec 1.0)"

func defaultEnvironment() Environment {
	return Environment{
		Stdout:   os.Stdout,
		Stderr:   os.Stderr,
		Stdin:    os.Stdin,
		ReadFile: os.ReadFile,
		Getenv:   os.Getenv,
		Now:      time.Now,
	}
}

func storeFor(env Environment) *handover.Store {
	return handover.NewStore(handover.ResolveStoreHome(env.Getenv))
}

// readTarget hands back BYTES, not text. A raw document arriving on stdin or
// from a file is bytes until the ingestion boundary has decided what they are:
// decoding here would let a byte order mark or a UTF-16 document through as
// something it is not.
func readTarget(target string, env Environment) ([]byte, error) {
	if target == "" || target == "-" {
		return io.ReadAll(env.Stdin)
	}
	return env.ReadFile(target)
}

// ingestRawDocument is the CLI's raw-document input path, in one place.
//
// Input arrives as bytes, often as a whole model reply with prose around the
// JSON. The encoding rule is about the bytes, so it is applied to the whole
// input first; the structural rules are about the document, so they are
// applied to the block lifted out of it. Both halves are the same boundary,
// and neither is skipped because the input happened to be a paste.
func ingestRawDocument(data []byte) (any, error) {
	if _, issue := handover.IngestBytes(data); issue != nil {
		// A prose reply is not a JSON document, so a syntax refusal here says
		// nothing: the encoding verdict is the part that binds on raw bytes.
		if issue.Code != handover.CodeSyntaxInvalidJSON {
			return nil, issue
		}
	}
	jsonText, ok := handover.ExtractJSONBlock(string(data))
	if !ok {
		return nil, errors.New("no JSON found in the input")
	}
	value, issue := handover.IngestText(jsonText)
	if issue != nil {
		return nil, issue
	}
	return value, nil
}

// allDigitsPattern is the bare-number form of a load code, the way the
// Node CLI reads it.
var allDigitsPattern = regexp.MustCompile(`^\d+$`)

func positionalArgs(args []string) []string {
	positional := []string{}
	for _, arg := range args {
		if !strings.HasPrefix(arg, "--") {
			positional = append(positional, arg)
		}
	}
	return positional
}

func hasFlag(args []string, flag string) bool {
	for _, arg := range args {
		if arg == flag {
			return true
		}
	}
	return false
}

// parseCandidate turns arbitrary text into a store-ready handover: pull the
// JSON out of whatever the model wrapped it in, normalize the loose shapes,
// then assign identity. The CLI save path is a writer, so a document that
// arrives without a handoverId gets a fresh UUIDv7 here; a document that
// already carries one keeps it, because a copy keeps its identity.
//
// An id that is present but malformed is left exactly as it is. Minting a
// fresh one over the top would replace an id the spec requires to be refused,
// and nobody would ever be told the original was wrong.
func parseCandidate(data []byte, now time.Time) (any, error) {
	parsed, err := ingestRawDocument(data)
	if err != nil {
		return nil, err
	}
	normalized := handover.Normalize(parsed)
	obj, ok := normalized.(*handover.Obj)
	if !ok || obj.Has("handoverId") {
		return normalized, nil
	}
	identified := obj.Clone()
	identified.Set("handoverId", handover.UUIDv7())
	return identified, nil
}

func cmdSave(args []string, env Environment) int {
	quiet := hasFlag(args, "--quiet")
	positional := positionalArgs(args)

	if len(positional) == 0 {
		fmt.Fprint(env.Stdout, handover.RenderRecipe())
		fmt.Fprint(env.Stdout,
			"\nPaste that into the session you want to keep. When the model answers with the JSON block, run:\n\n  soil save -\n\nand paste the reply.\n",
		)
		return 0
	}

	// A read failure is an environment error, reported the way the outer
	// handler reports one; a parse failure is the save path's own message.
	data, err := readTarget(positional[0], env)
	if err != nil {
		return reportError(err, env)
	}

	candidate, err := parseCandidate(data, env.Now())
	if err != nil {
		fmt.Fprintf(env.Stderr, "soil save: %s\n", err)
		return 1
	}

	result := handover.Validate(candidate)
	if !result.Valid {
		fmt.Fprintf(env.Stderr, "%s\n", handover.RenderValidation(result, "the pasted document"))
		return 1
	}

	store := storeFor(env)
	entry, err := store.Save(candidate)
	if err != nil {
		return reportError(err, env)
	}
	if quiet {
		fmt.Fprintf(env.Stdout, "%s\n", entry.Code)
		return 0
	}
	saved, err := store.Read(entry.Code)
	if err != nil {
		return reportError(err, env)
	}
	fmt.Fprintf(env.Stdout, "%s\n", handover.RenderSaved(saved, entry.Code))
	return 0
}

func cmdLoad(args []string, env Environment) int {
	positional := positionalArgs(args)
	code := "last"
	if len(positional) > 0 {
		code = positional[0]
	}
	store := storeFor(env)

	doc, err := store.Read(code)
	if err != nil {
		return reportError(err, env)
	}
	if hasFlag(args, "--json") {
		fmt.Fprintf(env.Stdout, "%s\n", handover.MarshalJSONIndent(doc))
		return 0
	}
	fmt.Fprintf(env.Stdout, "%s\n\n", handover.RenderLoaded(doc))
	// A load shows the recorded working-style instances the document carries,
	// the way the Node CLI's load does. Asking for the block is the caller's
	// decision and assembling it is the SDK's, so the heading carries this
	// render's marker and no document can spell a second one.
	fmt.Fprint(env.Stdout, handover.BuildRestorePromptWithOptions(doc, handover.RestoreOptions{
		WorkingStyleEvidence: true,
	}))
	return 0
}

func cmdList(env Environment) int {
	store := storeFor(env)
	entries, err := store.List()
	if err != nil {
		return reportError(err, env)
	}
	fmt.Fprintf(env.Stdout, "%s\n", handover.RenderList(entries))
	return 0
}

func cmdValidate(args []string, env Environment) int {
	positional := positionalArgs(args)
	if len(positional) == 0 {
		fmt.Fprint(env.Stderr, "soil validate: give a file path, or - for stdin\n")
		return 2
	}
	target := positional[0]
	data, err := readTarget(target, env)
	if err != nil {
		return reportError(err, env)
	}
	parsed, err := ingestRawDocument(data)
	if err != nil {
		fmt.Fprintf(env.Stderr, "soil validate: %s\n", err)
		return 1
	}
	result := handover.Validate(parsed)
	fmt.Fprintf(env.Stdout, "%s\n", handover.RenderValidation(result, target))
	if result.Valid {
		return 0
	}
	return 1
}

// cmdCheck is soil check: the open save-time baseline. Deterministic rules
// over the document itself, a grade band, exit 0 for strong or adequate and
// 1 for thin or failing, so a script or a CI step can gate on it. --attach
// writes the report onto the stored handover as a quality.capture
// observation through the store's update path, which keeps the handoverId
// and the code unchanged.
func cmdCheck(args []string, env Environment) int {
	attach := hasFlag(args, "--attach")
	asJSON := hasFlag(args, "--json")
	positional := positionalArgs(args)
	if len(positional) == 0 {
		fmt.Fprint(env.Stderr, "soil check: give a load code, a file path, or - for stdin\n")
		return 2
	}
	target := positional[0]

	store := storeFor(env)
	fromStore := strings.HasPrefix(target, "#") ||
		strings.ToLower(target) == "last" ||
		allDigitsPattern.MatchString(target)

	var doc *handover.Obj
	if fromStore {
		read, err := store.Read(target)
		if err != nil {
			return reportError(err, env)
		}
		doc = read
	} else {
		data, err := readTarget(target, env)
		if err != nil {
			return reportError(err, env)
		}
		candidate, err := parseCandidate(data, env.Now())
		if err != nil {
			fmt.Fprintf(env.Stderr, "soil check: %s\n", err)
			return 1
		}
		result := handover.Validate(candidate)
		if !result.Valid {
			fmt.Fprintf(env.Stderr, "%s\n", handover.RenderValidation(result, target))
			return 1
		}
		doc = candidate.(*handover.Obj)
	}

	report := handover.CheckHandover(doc)

	if attach {
		if !fromStore || !doc.Has("code") {
			fmt.Fprint(env.Stderr, "soil check: --attach needs a stored handover, give its load code\n")
			return 2
		}
		observation, err := handover.CheckObservation(doc, report, handover.CheckObservationOptions{
			ProducedBy: "soil-cli/" + cliVersion,
			ProducedAt: env.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		})
		if err != nil {
			return reportError(err, env)
		}
		attached := doc.Clone()
		observations := []any{}
		if existing, ok := doc.Get("observations"); ok {
			if list, ok := existing.([]any); ok {
				observations = append(observations, list...)
			}
		}
		observations = append(observations, observation)
		attached.Set("observations", observations)
		code, _ := doc.Get("code")
		if _, err := store.Update(code.(string), attached); err != nil {
			return reportError(err, env)
		}
	}

	if asJSON {
		fmt.Fprintf(env.Stdout, "%s\n", handover.MarshalJSONIndent(handover.CheckReportValue(report)))
	} else {
		fmt.Fprintf(env.Stdout, "%s\n", handover.RenderCheck(doc, report))
		if attach {
			code, _ := doc.Get("code")
			fmt.Fprintf(env.Stdout, "\n  report attached to %s as a quality.capture observation\n", code)
		}
	}
	if report.Grade == "strong" || report.Grade == "adequate" {
		return 0
	}
	return 1
}

func cmdRender(args []string, env Environment) int {
	positional := positionalArgs(args)
	if len(positional) == 0 {
		fmt.Fprint(env.Stderr, "soil render: give a load code or a file path\n")
		return 2
	}
	target := positional[0]

	var doc any
	if strings.HasPrefix(target, "#") {
		read, err := storeFor(env).Read(target)
		if err != nil {
			return reportError(err, env)
		}
		doc = read
	} else {
		data, err := env.ReadFile(target)
		if err != nil {
			return reportError(err, env)
		}
		parsed, err := ingestRawDocument(data)
		if err != nil {
			return reportError(err, env)
		}
		doc = parsed
	}

	if hasFlag(args, "--json") {
		fmt.Fprintf(env.Stdout, "%s\n", handover.MarshalJSONIndent(doc))
		return 0
	}
	result := handover.Validate(doc)
	if !result.Valid {
		fmt.Fprintf(env.Stdout, "%s\n", handover.RenderValidation(result, target))
		return 1
	}
	fmt.Fprintf(env.Stdout, "%s\n", handover.RenderLoaded(doc.(*handover.Obj)))
	return 0
}

func reportError(err error, env Environment) int {
	var notFound *handover.NotFoundError
	if errors.As(err, &notFound) {
		fmt.Fprintf(env.Stderr, "soil: %s. Run `soil list` to see what is stored.\n", err)
		return 1
	}
	fmt.Fprintf(env.Stderr, "soil: %s\n", err)
	return 1
}

// Run runs one command and returns the process exit code.
func Run(argv []string, env Environment) int {
	if len(argv) == 0 {
		fmt.Fprint(env.Stdout, help)
		return 0
	}
	command, args := argv[0], argv[1:]

	switch command {
	case "-h", "--help", "help":
		fmt.Fprint(env.Stdout, help)
		return 0
	case "-v", "--version", "version":
		fmt.Fprintf(env.Stdout, "%s\n", version)
		return 0
	case "save":
		return cmdSave(args, env)
	case "load":
		return cmdLoad(args, env)
	case "list", "ls":
		return cmdList(env)
	case "validate":
		return cmdValidate(args, env)
	case "check":
		return cmdCheck(args, env)
	case "render":
		return cmdRender(args, env)
	case "rescue":
		fmt.Fprintf(env.Stdout, "%s\n", handover.RescuePrompt)
		return 0
	case "where":
		fmt.Fprintf(env.Stdout, "%s\n", handover.ResolveStoreHome(env.Getenv))
		return 0
	default:
		fmt.Fprintf(env.Stderr, "soil: unknown command %q\n\n%s", command, help)
		return 2
	}
}

func main() {
	os.Exit(Run(os.Args[1:], defaultEnvironment()))
}
