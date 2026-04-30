import * as React from "react"
import { Input } from "./input"

/**
 * NumericInput: Input numérico que muestra vacío solo al inicio cuando el valor es 0,
 * pero permite escribir valores como 0.015 sin perder el "0".
 */
const NumericInput = React.forwardRef(({ value, onChange, ...props }, ref) => {
  const [localValue, setLocalValue] = React.useState('')
  const [isFocused, setIsFocused] = React.useState(false)

  // Sync external value when not focused
  React.useEffect(() => {
    if (!isFocused) {
      setLocalValue(value === 0 || value === '0' || value === null || value === undefined ? '' : String(value))
    }
  }, [value, isFocused])

  const handleChange = (e) => {
    setLocalValue(e.target.value)
    if (onChange) onChange(e)
  }

  return (
    <Input
      ref={ref}
      type="number"
      value={isFocused ? localValue : (value === 0 || value === '0' || value === null || value === undefined ? '' : String(value))}
      onChange={handleChange}
      onFocus={() => {
        setIsFocused(true)
        setLocalValue(value === 0 || value === '0' || value === null || value === undefined ? '' : String(value))
      }}
      onBlur={() => setIsFocused(false)}
      {...props}
    />
  )
})
NumericInput.displayName = "NumericInput"

export { NumericInput }
